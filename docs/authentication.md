# HTTP authentication

SORESPO uses StratoWeave's server-side authentication service. Enable OpenID
Connect, a single local fallback account, or both. An OIDC subject on the
configured allowlist and the local account receive full application access.
Groups, roles, and per-resource permissions are not implemented in this version.
NETCONF SSH credentials are configured independently.

The SPA and APIs must share an origin. StratoWeave handles Authorization Code
flow with S256 PKCE, nonce and browser-bound state, discovery, and RS256 ID-token
signature/claim validation. The browser delivers the one-time authorization
code to `/auth/oidc/callback`; the backend exchanges it and redirects to a clean
SPA URL. Access, refresh and ID tokens remain in the backend. The browser holds
an opaque HttpOnly cookie and an in-memory CSRF token, never OAuth tokens.

## Configuration

Settings use the existing StratoWeave CLI/AON/environment configuration system.
In environment variable names, **dots become double underscores**. For example:

```bash
export STRATOWEAVE_HTTP__AUTH__PUBLIC_ORIGIN=https://sorespo.example.com
export STRATOWEAVE_HTTP__AUTH__OIDC__ISSUER=https://identity.example.com
export STRATOWEAVE_HTTP__AUTH__OIDC__CLIENT_ID=sorespo
export STRATOWEAVE_HTTP__AUTH__OIDC__CLIENT_SECRET_FILE=/run/secrets/oidc-client
export STRATOWEAVE_HTTP__AUTH__OIDC__ALLOWED_SUBJECTS='["provider-subject-1"]'
export STRATOWEAVE_HTTP__AUTH__LOCAL__USERNAME=admin
export STRATOWEAVE_HTTP__AUTH__LOCAL__PASSWORD_HASH_FILE=/run/secrets/http-password-hash
out/bin/sorespo
```

Register a confidential web client at the provider with the exact callback
`https://sorespo.example.com/auth/oidc/callback`, code flow, S256 PKCE and RS256
ID tokens. The client must permit `client_secret_basic` or `client_secret_post`.
Use the ID token's `sub` claim for the allowlist, not email or display name.
The issuer is matched exactly against discovery and tokens. The default scopes
are `openid profile email offline_access`; offline access requests consent so
the provider can issue refresh tokens.

The initial interoperability profile accepts RS256, a single client audience,
and integral token timestamps/lifetimes. Provider HTTP responses use Acton's
parser; chunk extensions are not currently supported. The quicklab Dex provider
is covered by the integration tests.

The local hash file contains a bcrypt password hash, with no default production
password. The local login accepts passwords up to bcrypt's 72-byte limit and is
rate limited. Client credentials and hash files must be readable by the process;
they are not part of the network configuration tree exposed through APIs.

Native HTTPS uses `http.tls.certificate_file` and `http.tls.private_key_file`,
with PEM files. Alternatively, terminate HTTPS at a reverse proxy and keep the
backend listener private. `http.auth.public_origin` is explicit; arbitrary
forwarded headers cannot change it. Production cookies have `Secure`,
`HttpOnly`, `SameSite=Strict`, `Path=/`, and the `__Host-` prefix. A temporary
login cookie uses `SameSite=Lax` for the provider's callback.

For isolated development, `http.auth.allow_insecure_http=True` allows HTTP
origins and provider endpoints on localhost/loopback names. This is explicitly
enabled by quicklab, whose published ports bind to loopback. TLS verification
is never disabled for HTTPS provider endpoints.

Authentication is opt-in for existing deployments. Partial configuration is
rejected. Once enabled, RESTCONF, TMF, device, queue, layer and application
extension API routes require authentication. Static UI files and login
bootstrap remain public. A provider outage cannot disable API authentication;
the local fallback operates independently.

## Sessions and API clients

`GET /auth/session` returns authentication availability and session metadata.
It creates a temporary pre-login cookie and returns `csrf_token` when needed.
To use local login, POST JSON `{"username":"...","password":"..."}` to
`/auth/local/login` with that cookie, `X-CSRF-Token`, and an `Origin` header equal
to the configured public origin. A successful login rotates both the cookie
and CSRF token. All mutating API calls and `POST /auth/logout` require the
authenticated cookie, current CSRF token and matching Origin.

Device resync is now `POST /device/{name}/resync`; GET no longer changes state.
Unauthenticated API requests return 401 instead of a provider redirect. Clients
must explicitly sign in again and must not automatically replay failed writes.

The default idle lifetime is 30 minutes and the absolute lifetime is 8 hours,
configured by `http.auth.session_idle_seconds` and
`http.auth.session_absolute_seconds`. Backend refresh is serialized per session
and retains rotated refresh tokens. Permanent renewal rejection ends the
session; transient provider failure returns 503 from protected APIs. The session
bootstrap still returns local-login metadata so fallback remains available.
Without a refresh token,
renewal requires signing in again. Local logout invalidates the app session
immediately and attempts provider token revocation when advertised. It does not
log the user out of every application at the identity provider.

Sessions are process-local and disappear on restart. StratoWeave's normal TTT
database option does not persist them. Authentication rejects Acton durable
runtime builds, which could otherwise serialize tokens from actor state.

## Development and references

See [quicklab authentication](../test/quicklab-notconf/README.md#authentication)
for test credentials, test commands and Vite configuration.

Build and test changes across the local repositories with:

```bash
make test DEP_OVERRIDES='--dep stratoweave=../stratoweave --dep http_router=../http-router --no-cache'
make build DEP_OVERRIDES='--dep stratoweave=../stratoweave --dep http_router=../http-router'
```

For the Colima lab on an Apple Silicon host, add
`TARGET='--target aarch64-linux-gnu.2.27'` to `make build` before copying the binary.

The protocol follows [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
and [OAuth security best current practice](https://www.rfc-editor.org/rfc/rfc9700.html).
The token-isolation design follows the [BFF pattern in RFC 10017](https://www.ietf.org/ietf-ftp/rfc/rfc10017.html#section-6.1).
HttpOnly cookies prevent JavaScript from reading session credentials, but a
compromised SPA can still make requests through the active session.
