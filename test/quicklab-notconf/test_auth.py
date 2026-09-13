#!/usr/bin/env python3
"""Exercise real quicklab OIDC redirects, backend refresh and local sessions.

Uses curl as a browser-like HTTP client. OAuth tokens must never cross this
client: only the provider's login form, authorization code and app cookie do.
Run after `make start copy run-and-configure` in a separate terminal.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit


TOKEN_KEYS = {"access_token", "refresh_token", "id_token", "client_secret"}


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def assert_no_tokens(value):
    if isinstance(value, dict):
        check(not TOKEN_KEYS.intersection(value), "OAuth credentials exposed to browser")
        for item in value.values():
            assert_no_tokens(item)
    elif isinstance(value, list):
        for item in value:
            assert_no_tokens(item)
    elif isinstance(value, str):
        check(not re.search(r"eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+", value), "JWT exposed to browser")


@dataclass
class Response:
    status: int
    headers: dict
    body: str
    url: str

    def json(self):
        value = json.loads(self.body)
        assert_no_tokens(value)
        return value


class Client:
    def __init__(self, root, name, origin, issuer):
        self.directory = root / name
        self.directory.mkdir()
        self.cookies = self.directory / "cookies"
        self.origin = origin
        self.issuer = issuer

    def request(self, path, method="GET", data=None, headers=None, form=None):
        url = urljoin(self.origin + "/", path)
        parsed = urlsplit(url)
        origins = {(urlsplit(base).scheme, urlsplit(base).netloc) for base in [self.origin, self.issuer]}
        check((parsed.scheme, parsed.netloc) in origins, "Unexpected redirect origin")
        # curl resolves .localhost itself; explicitly resolving also supports
        # older curl versions without modifying the host's DNS configuration.
        command = ["curl", "--silent", "--show-error", "--max-time", "20",
                   "--resolve", f"oidc.localhost:{urlsplit(self.issuer).port}:127.0.0.1",
                   "--cookie", str(self.cookies), "--cookie-jar", str(self.cookies),
                   "--request", method, "--dump-header", str(self.directory / "headers"),
                   "--output", str(self.directory / "body"), "--write-out", "%{http_code}"]
        for name, value in (headers or {}).items():
            command += ["--header", name + ": " + value]
        payload = None
        if data is not None:
            command += ["--header", "Content-Type: application/json", "--data-binary", "@-"]
            payload = json.dumps(data)
        if form is not None:
            command += ["--header", "Content-Type: application/x-www-form-urlencoded", "--data-binary", "@-"]
            payload = urlencode(form)
        result = subprocess.run(command + [url], input=payload, capture_output=True, text=True)
        check(result.returncode == 0, "HTTP request failed (check running lab)")
        raw_headers = (self.directory / "headers").read_text()
        response_headers = {}
        for line in raw_headers.splitlines():
            if ":" in line:
                name, value = line.split(":", 1)
                response_headers[name.lower()] = value.strip()
        body = (self.directory / "body").read_text()
        if url.startswith(self.origin):
            assert_no_tokens(body)
        return Response(int(result.stdout), response_headers, body, url)

    def session(self):
        response = self.request("/auth/session")
        check(response.status == 200, "Session bootstrap failed")
        check("no-store" in response.headers.get("cache-control", ""), "Session must not be cached")
        return response.json()

    def headers(self, status):
        return {"Origin": self.origin, "X-CSRF-Token": status["csrf_token"]}


class Forms(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.forms = []
        self.current = None
        self.feed(html)

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == "form":
            self.current = {"action": attrs.get("action", ""), "fields": {}}
            self.forms.append(self.current)
        elif tag in {"input", "button"} and self.current is not None and attrs.get("name"):
            self.current["fields"][attrs["name"]] = attrs.get("value", "")

    def handle_endtag(self, tag):
        if tag == "form":
            self.current = None


def oidc_login(client, email, expected=True):
    client.session()
    response = client.request("/auth/oidc/login")
    check(response.status in {302, 303}, "OIDC login did not redirect")
    authorization = response.headers["location"]
    query = parse_qs(urlsplit(authorization).query)
    check(query.get("response_type") == ["code"], "OIDC must use code flow")
    check(query.get("code_challenge_method") == ["S256"], "OIDC must require S256 PKCE")
    check(bool(query.get("nonce")) and bool(query.get("state")), "Missing nonce/state")
    check(not TOKEN_KEYS.intersection(query), "Secret in authorization URL")
    check(query.get("redirect_uri") == [client.origin + "/auth/oidc/callback"], "Wrong callback")
    response = client.request(authorization)
    callback = None
    for _ in range(12):
        if response.status in {302, 303}:
            location = urljoin(response.url, response.headers["location"])
            if location.startswith(client.origin + "/auth/oidc/callback?"):
                callback = location
                response = client.request(location)
                break
            response = client.request(location)
            continue
        check(response.status == 200, "Provider did not render a login/consent form")
        forms = Forms(response.body).forms
        check(bool(forms), "Provider login form missing")
        form = forms[0]
        fields = form["fields"]
        if "login" in fields or "password" in fields:
            fields.update(login=email, password="quicklab-oidc-password")
        else:
            fields["approval"] = "approve"
        response = client.request(urljoin(response.url, form["action"]), "POST", form=fields)
    check(callback is not None, "Provider flow never reached backend callback")
    if expected:
        check(response.status in {302, 303}, "Backend rejected allowed OIDC identity")
        location = response.headers.get("location", "")
        check("code=" not in location and "state=" not in location, "Callback URL was not cleaned")
        status = client.session()
        check(status["authenticated"], "OIDC did not establish session")
        check(status["user"]["subject"] == "Cg5xdWlja2xhYi1hZG1pbhIFbG9jYWw", "Unexpected Dex subject")
    else:
        check(response.status in {400, 403}, "Unlisted subject was not denied")
        check(not client.session()["authenticated"], "Unlisted subject obtained a session")
    return callback


def run(origin, issuer, refresh_wait, provider_container=None):
    with tempfile.TemporaryDirectory(prefix="sorespo-auth-test-") as directory:
        root = Path(directory)
        client = Client(root, "local", origin, issuer)
        status = client.session()
        check(status["enabled"] and not status["authenticated"], "Quicklab authentication is not enabled")
        check(status["local_enabled"] and status["oidc_enabled"], "Both login methods must be available")
        for path in ["/device", "/config-queue", "/layer/0", "/restconf/data",
                     "/tmf-api/ServiceActivationAndConfiguration/v4/service"]:
            check(client.request(path).status == 401, "Protected API accepts anonymous access: " + path)
        check(client.request("/devices", headers={"Accept": "text/html"}).status == 200, "SPA deep link unavailable")
        credentials = {"username": "admin", "password": "quicklab-local-password"}
        check(client.request("/auth/local/login", "POST", credentials).status == 403, "Local login accepts missing CSRF")
        headers = client.headers(status)
        bad_origin = dict(headers, Origin="http://attacker.example")
        check(client.request("/auth/local/login", "POST", credentials, bad_origin).status == 403, "Local login accepts foreign Origin")
        wrong = dict(credentials, password="incorrect-password")
        check(client.request("/auth/local/login", "POST", wrong, headers).status == 401, "Wrong local password accepted")
        time.sleep(2)
        before = client.cookies.read_text()
        response = client.request("/auth/local/login", "POST", credentials, headers)
        check(response.status == 200, "Local login failed")
        check("httponly" in response.headers.get("set-cookie", "").lower(), "Session cookie missing HttpOnly")
        check("samesite=" in response.headers.get("set-cookie", "").lower(), "Session cookie missing SameSite")
        check(client.cookies.read_text() != before, "Login did not rotate preauth cookie")
        status = response.json()
        check(status["authenticated"], "Local session unauthenticated")
        check(client.request("/device").status == 200, "Local session cannot access API")
        check(client.request("/device/AMS-CORE-1/resync").status in {404, 405}, "Resync still accepts GET")
        check(client.request("/device/AMS-CORE-1/resync", "POST").status == 403, "Mutation accepts missing CSRF")
        check(client.request("/auth/logout", "POST").status == 403, "Logout accepts missing CSRF")
        headers = client.headers(status)
        response = client.request("/auth/logout", "POST", {}, headers)
        check(response.status in {200, 204}, "Logout failed")
        check(client.request("/device").status == 401, "Logged-out session still accepted")
        print("PASS local fallback, route protection, CSRF, cookie rotation and logout", flush=True)

        denied = Client(root, "denied", origin, issuer)
        oidc_login(denied, "denied@quicklab.example", expected=False)
        print("PASS provider subject allowlist", flush=True)

        oidc = Client(root, "oidc", origin, issuer)
        callback = oidc_login(oidc, "admin@quicklab.example")
        check(oidc.request("/device").status == 200, "OIDC session cannot access API")
        check(oidc.request(callback).status in {400, 403}, "OIDC callback can be replayed")
        print("PASS OIDC code flow, S256, identity validation and callback replay rejection", flush=True)

        print(f"Waiting {refresh_wait}s to cross the provider's 30s token lifetime...", flush=True)
        time.sleep(refresh_wait)
        clones = [Client(root, "refresh-" + str(i), origin, issuer) for i in range(8)]
        for clone in clones:
            shutil.copyfile(oidc.cookies, clone.cookies)
        with ThreadPoolExecutor(max_workers=8) as executor:
            codes = list(executor.map(lambda clone: clone.request("/device").status, clones))
        check(codes == [200] * 8, "Concurrent requests failed during token refresh")
        status = oidc.session()
        check(status["authenticated"], "Session expired instead of refreshing")
        # A second renewal proves the rotated refresh token was retained.
        time.sleep(refresh_wait)
        check(oidc.request("/device").status == 200, "Second token refresh failed")
        check(oidc.request("/auth/logout", "POST", {}, oidc.headers(status)).status in {200, 204}, "OIDC logout failed")
        check(oidc.request("/device").status == 401, "OIDC session survived logout")
        print("PASS concurrent refresh, refresh rotation, cookie-only API access and OIDC logout", flush=True)

        if provider_container:
            outage = Client(root, "outage", origin, issuer)
            oidc_login(outage, "admin@quicklab.example")
            subprocess.run(["docker", "stop", "--time", "2", provider_container], check=True, capture_output=True)
            try:
                print("Provider stopped; waiting for token expiry to check local fallback...", flush=True)
                time.sleep(refresh_wait)
                check(outage.request("/device").status == 503, "Provider outage bypassed renewal protection")
                status = outage.session()
                check(not status["authenticated"] and status.get("provider_unavailable"), "Outage bootstrap did not expose reauthentication")
                check(status["local_enabled"], "Outage hid the local fallback")
                response = outage.request("/auth/local/login", "POST", credentials, outage.headers(status))
                check(response.status == 200 and response.json()["authenticated"], "Local fallback depends on provider availability")
                check(outage.request("/device").status == 200, "Local fallback session cannot access API during outage")
                check(outage.request("/auth/logout", "POST", {}, outage.headers(response.json())).status in {200, 204}, "Local fallback logout failed")
            finally:
                subprocess.run(["docker", "start", provider_container], check=True, capture_output=True)
            for _ in range(20):
                try:
                    if outage.request(issuer + "/.well-known/openid-configuration").status == 200:
                        break
                except AssertionError:
                    pass
                time.sleep(1)
            restarted = Client(root, "restarted", origin, issuer)
            oidc_login(restarted, "admin@quicklab.example")
            status = restarted.session()
            check(restarted.request("/auth/logout", "POST", {}, restarted.headers(status)).status in {200, 204}, "Restarted-provider session logout failed")
            print("PASS provider outage, independent local fallback and signing-key rotation after provider restart", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", default="http://localhost:3000")
    parser.add_argument("--issuer", default="http://oidc.localhost:5556/dex")
    parser.add_argument("--refresh-wait", type=int, default=35)
    parser.add_argument("--provider-container", help="Optional quicklab Dex container to stop/restart for outage testing")
    args = parser.parse_args()
    run(args.origin.rstrip("/"), args.issuer.rstrip("/"), args.refresh_wait, args.provider_container)
