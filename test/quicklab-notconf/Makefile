TESTENV=sorespo-quicklab-notconf
export OIDC_PORT?=5556
export AUTH_PUBLIC_ORIGIN?=http://localhost:$(WEBUI_PORT)
CLAB_EXTRA_ENV=-e OIDC_PORT=$(OIDC_PORT) -e AUTH_PUBLIC_ORIGIN=$(AUTH_PUBLIC_ORIGIN)
HTTP_CURL=python3 ../common/session_curl.py --origin $(STRATOWEAVE_API_ORIGIN) --public-origin $(AUTH_PUBLIC_ORIGIN)

ROUTERS_XR=ams-core-1 fra-core-1
ROUTERS_CRPD=sto-core-1 lju-core-1

include ../common/clab.mk
include ../common/notconf.mk
include ../common/quicklab.mk

.PHONY: test-auth
test-auth:
	python3 test_auth.py --origin $(AUTH_PUBLIC_ORIGIN) --issuer http://oidc.localhost:$(OIDC_PORT)/dex --provider-container $(TESTENV)-oidc
