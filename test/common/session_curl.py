#!/usr/bin/env python3
"""Run curl against an authenticated quicklab API using an ephemeral session.

Only for disposable labs. Credentials can be overridden through
SORESPO_LOCAL_USER and SORESPO_LOCAL_PASSWORD. No session is saved between runs.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--public-origin", help="Browser origin when a Vite proxy uses a different port")
    options, curl_args = parser.parse_known_args()
    origin = options.origin.rstrip("/")
    public_origin = (options.public_origin or origin).rstrip("/")
    if not curl_args:
        parser.error("expected curl arguments")
    # The session and CSRF header belong exclusively to this API origin.
    urls = [arg for arg in curl_args if arg.startswith(("http://", "https://"))]
    expected = urlsplit(origin)
    if not urls or any((urlsplit(url).scheme, urlsplit(url).netloc) !=
                       (expected.scheme, expected.netloc) for url in urls):
        parser.error("every target URL must use the configured API origin")
    if any(arg in {"-L", "--location", "--location-trusted", "--next"} for arg in curl_args):
        parser.error("redirect following and multiple curl operations are not supported")

    with tempfile.TemporaryDirectory(prefix="sorespo-session-") as directory:
        cookies = str(Path(directory) / "cookies")

        def request(path, data=None, csrf=None):
            command = ["curl", "--fail", "--silent", "--show-error", "--max-time", "20",
                       "--cookie", cookies, "--cookie-jar", cookies,
                       "--header", "Origin: " + public_origin]
            if data is not None:
                command += ["--header", "Content-Type: application/json", "--data-binary", "@-"]
            if csrf:
                command += ["--header", "X-CSRF-Token: " + csrf]
            response = subprocess.run(command + [origin + path],
                                      input=json.dumps(data) if data is not None else None,
                                      capture_output=True, text=True, check=True)
            return json.loads(response.stdout)

        status = request("/auth/session")
        if not status.get("enabled"):
            return subprocess.run(["curl", *curl_args]).returncode
        status = request("/auth/local/login", {
            "username": os.environ.get("SORESPO_LOCAL_USER", "admin"),
            "password": os.environ.get("SORESPO_LOCAL_PASSWORD", "quicklab-local-password"),
        }, status["csrf_token"])
        if not status.get("authenticated"):
            raise RuntimeError("Local login did not establish a session")
        try:
            return subprocess.run(["curl", "--cookie", cookies,
                                   "--header", "Origin: " + public_origin,
                                   "--header", "X-CSRF-Token: " + status["csrf_token"],
                                   *curl_args]).returncode
        finally:
            try:
                request("/auth/logout", {}, status["csrf_token"])
            except (subprocess.CalledProcessError, ValueError):
                pass


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (subprocess.CalledProcessError, KeyError, ValueError, RuntimeError) as error:
        # Do not print subprocess arguments or response bodies with credentials.
        print("Quicklab session login failed; check the API and local credentials.", file=sys.stderr)
        sys.exit(1)
