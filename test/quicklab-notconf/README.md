# Quicklab NOTCONF

## Authentication

This lab enables OpenID Connect through pinned Dex `v2.45.1`, plus one local
fallback HTTP account. Start the lab and app as usual:

```bash
make -C test/quicklab-notconf start copy run-and-configure
```

Open <http://localhost:3000>. Use either **Sign in with OpenID Connect** or the
local login form:

| Login | Username/email | Password | Access |
|---|---|---|---|
| OIDC | `admin@quicklab.example` | `quicklab-oidc-password` | Full application access |
| OIDC | `denied@quicklab.example` | `quicklab-oidc-password` | Rejected by the subject allowlist |
| Local fallback | `admin` | `quicklab-local-password` | Full application access |

These are disposable test credentials. The provider configuration, client
secret and local bcrypt hash are in `oidc/`. The issuer is
`http://oidc.localhost:5556/dex`: browsers resolve `.localhost` to loopback,
while Docker's network alias resolves it to Dex inside the lab. The same issuer
appears in discovery, authorization requests and signed tokens. There is no
issuer rewrite or disabled HTTPS verification. Both published HTTP ports bind
to loopback; the lab explicitly enables the backend's development HTTP mode.

Dex's stable `sub` encodes both the local connector and user ID. The allowed
fixture subject is `Cg5xdWlja2xhYi1hZG1pbhIFbG9jYWw`, representing
`quicklab-admin` through connector `local`. Tokens expire in 30 seconds to make
backend refresh observable; refresh tokens rotate on use.

From a second terminal, run the real-provider authentication tests:

```bash
make -C test/quicklab-notconf test-auth
make -C test/quicklab-notconf test-restconf-get
```

`test-auth` exercises local login, CSRF/origin checks, protected APIs, the denied
subject, OIDC redirects/PKCE, callback replay, two refresh cycles with concurrent
API requests, logout, and local fallback while Dex is stopped. It restarts Dex
and verifies a new login with the rotated signing key. It takes roughly two
minutes and briefly interrupts provider logins. OAuth tokens never reach
the test's browser-like client. Existing `get-config-*`, `send-config-*` and
resync targets use an ephemeral local session through `session_curl.py`.

After rebuilding the Linux binary, stop the previous foreground app with
Ctrl-C, then run:

```bash
make -C test/quicklab-notconf copy run-and-configure
```

For Vite development, configure its origin as the public application origin
when restarting the lab, then run `dev-webui` in another terminal:

```bash
make -C test/quicklab-notconf start copy run-and-configure AUTH_PUBLIC_ORIGIN=http://localhost:5173
make -C test/quicklab-notconf dev-webui
```

Use <http://localhost:5173> for this configuration. Vite proxies `/auth` and the
APIs; CSRF Origin checks and the registered provider callback still agree on one
explicit origin. `WEBUI_PORT` and `OIDC_PORT` can be overridden on lab creation.
See [HTTP authentication](../../docs/authentication.md) for production settings,
HTTPS, session behavior and protocol limitations.

## Network topology

This lab contains four core routers. Two of the PE routers are Juniper cRPD,
the other two are Cisco IOS XRd. Or ... that's what StratoWeave will think when
it connects to these devices which are actually NOTCONF devices simulating the
northbound interfaces (YANG models) of those vendors.

NOTCONF does not have a dataplane, nor management plane. Therefor there are no
actual CPEs in this lab (but the SORESPO CFS input is still structured as if
there were).
```
+-------------------+                                                                     +-------------------+   
|      cust-1       |                                                                     |      cust-3       |   
|    10.200.1.1     |                                                                     |    10.200.1.3     |   
|  (Cisco IOS XRd)  |                                                                     |  (Cisco IOS XRd)  |   
+----+--------------+                                                                     +--+----------------+   
     |Gi0/0/0/0.100                                                                          |Gi0/0/0/0.100       
     |                                                                                       |                    
     +-------------------+                                                                   |                    
                         |                                                                   |                    
                         |Gi0/0/0/2.100                                                      |                    
                      +--+----------------+                          +-------------------+   |                    
                      |    ams-core-1     |Gi0/0/0/1                 |    sto-core-1     |   |                    
                      |     10.0.0.1      +--------------------------+     10.0.0.3      +---+                    
                      |  (Cisco IOS XRd)  |                      eth1|  (Juniper cRPD)   |eth4.100                
                      +--+----------------+                          +--+--------------+-+                        
                         |Gi0/0/0/0                                     |eth2      eth3|                          
                         |                                              |              |                          
                         |                                              |              |                          
                         |                                              |              |                          
                         |                           +------------------+              |                          
                         |                           |                                 |                          
                         |                           |                                 |                          
                         |                           |                                 |                          
                         |                           |                                 |                          
                         |Gi0/0/0/1                  |                             eth2|                          
                      +--+----------------+Gi0/0/0/2 |               +-----------------+-+                        
                      |    fra-core-1     +----------+               |    lju-core-1     |                        
                      |     10.0.0.2      |Gi0/0/0/3             eth1|     10.0.0.4      |                        
                      |  (Cisco IOS XRd)  +--------------------------+   (Juniper cRPD)  |                        
                      +---+---------------+                          +--------+----------+                        
                          |Gi0/0/0/4.100                                      |eth3.100                           
                          |                                                   |                                   
 +-------------------+    |                                                   |              +-------------------+
 |      cust-2       |    |                                                   |              |      cust-44      |
 |    10.200.1.2     +----+                                                   |Gi0/0/0/0.100 |    10.200.1.4     |
 |  (Cisco IOS XRd)  |Gi0/0/0/0.100                                           +--------------+  (Cisco IOS XRd)  |
 +-------------------+                                                                       +-------------------+
 ```
