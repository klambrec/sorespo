import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AuthenticationRequired, SessionController, canAccessApplication, type Session } from '../src/lib/core/auth/controller';

const anonymous: Session = {
  enabled: true, authenticated: false, oidc_enabled: true, local_enabled: true,
  user: null, csrf_token: 'pre-login-csrf'
};
const authenticated: Session = {
  ...anonymous, authenticated: true, csrf_token: 'session-csrf',
  user: { subject: 'allowed-subject', display_name: 'Test operator' }
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' }
});
const controller = () => new SessionController(() => 'https://sorespo.example', () => {});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('browser sessions', () => {
  it('checks the session once before concurrent loaders and sends no API requests before sign-in', async () => {
    const session = controller();
    const calls: string[] = [];
    const transport = (async (input) => {
      calls.push(String(input));
      return json(anonymous);
    }) as typeof fetch;
    const results = await Promise.allSettled([
      session.fetch('/device', {}, transport), session.fetch('/config-queue', {}, transport)
    ]);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 2);
    assert.deepEqual(calls, ['/auth/session']);
    assert.equal(canAccessApplication(session.state), false);
  });

  it('fails closed on a missing, broken or malformed session endpoint', async () => {
    for (const response of [new Response('Missing', { status: 404 }), json({ enabled: false }), json('<html>')]) {
      const session = controller();
      const calls: string[] = [];
      const transport = (async (input) => { calls.push(String(input)); return response; }) as typeof fetch;
      await assert.rejects(session.fetch('/device', {}, transport));
      await assert.rejects(session.fetch('/config-queue', {}, transport));
      assert.deepEqual(calls, ['/auth/session']);
      assert.equal(canAccessApplication(session.state), false);
    }
  });

  it('attaches CSRF only to mutations and forces same-origin cookies with no redirect following', async () => {
    const session = controller();
    const requests: RequestInit[] = [];
    const transport = (async (input, init) => {
      if (String(input) === '/auth/session') return json(authenticated);
      requests.push(init!);
      return json({});
    }) as typeof fetch;
    await session.fetch('/device', {}, transport);
    await session.fetch('/device/r1/resync', {
      method: 'POST', credentials: 'include', redirect: 'follow', headers: { async: 'true' }
    }, transport);
    assert.equal(new Headers(requests[0].headers).has('X-CSRF-Token'), false);
    assert.equal(new Headers(requests[1].headers).get('X-CSRF-Token'), 'session-csrf');
    assert.equal(new Headers(requests[1].headers).get('async'), 'true');
    for (const request of requests) {
      assert.equal(request.credentials, 'same-origin');
      assert.equal(request.redirect, 'error');
      assert.equal(request.cache, 'no-store');
      assert.equal(new Headers(request.headers).has('Authorization'), false);
    }
  });

  it('rejects external destinations before sending cookies or CSRF', async () => {
    const session = controller();
    let calls = 0;
    const transport = (async () => { calls += 1; return json(authenticated); }) as typeof fetch;
    for (const url of ['https://evil.example/device', '//evil.example/device']) {
      await assert.rejects(session.fetch(url, { method: 'POST' }, transport), /application origin/);
    }
    assert.equal(calls, 0);
  });

  it('expires on 401, obtains fresh login CSRF, and never retries the original mutation', async () => {
    const session = controller();
    const calls: string[] = [];
    let sessionReads = 0;
    const transport = (async (input) => {
      calls.push(String(input));
      if (String(input) === '/auth/session') return json(sessionReads++ === 0 ? authenticated : anonymous);
      return json({ error: 'session expired' }, 401);
    }) as typeof fetch;
    await assert.rejects(session.fetch('/device/r1/resync', { method: 'POST' }, transport), AuthenticationRequired);
    await session.ensureSession(transport);
    assert.equal(session.state.session?.authenticated, false);
    assert.equal(session.state.session?.csrf_token, 'pre-login-csrf');
    assert.deepEqual(calls, ['/auth/session', '/device/r1/resync', '/auth/session']);
    await assert.rejects(session.fetch('/device', {}, transport), AuthenticationRequired);
    assert.equal(calls.length, 3);
  });

  it('uses pre-login CSRF, rotates client metadata on sign-in, and never retains unexpected token fields', async () => {
    const session = controller();
    let loginRequest: RequestInit | undefined;
    const transport = (async (input, init) => {
      if (String(input) === '/auth/session') return json(anonymous);
      loginRequest = init;
      return json({ ...authenticated, access_token: 'must-not-be-retained', refresh_token: 'must-not-be-retained' });
    }) as typeof fetch;
    await session.login('operator', 'local-password', transport);
    assert.equal(new Headers(loginRequest?.headers).get('X-CSRF-Token'), 'pre-login-csrf');
    assert.deepEqual(JSON.parse(String(loginRequest?.body)), { username: 'operator', password: 'local-password' });
    assert.equal(canAccessApplication(session.state), true);
    assert.deepEqual(session.state.session, authenticated);
    assert.equal(JSON.stringify(session.state).includes('local-password'), false);
    assert.equal(JSON.stringify(session.state).includes('must-not-be-retained'), false);
  });

  it('keeps a rejected local login anonymous and avoids reflecting arbitrary server error text', async () => {
    const session = controller();
    const transport = (async (input) => String(input) === '/auth/session'
      ? json(anonymous) : json({ error: '<script>server-detail</script>' }, 401)) as typeof fetch;
    await assert.rejects(session.login('operator', 'wrong-password', transport), /Incorrect username or password/);
    assert.equal(canAccessApplication(session.state), false);
    assert.equal(session.state.session?.csrf_token, 'pre-login-csrf');
  });

  it('offers local fallback when an existing OIDC session cannot refresh during a provider outage', async () => {
    const session = controller();
    const calls: string[] = [];
    const transport = (async (input, init) => {
      calls.push(String(input));
      if (String(input) === '/auth/session') {
        // The backend keeps the OIDC session for a later retry, but reports
        // only unauthenticated metadata and its CSRF token to this tab.
        return json({ ...anonymous, csrf_token: 'session-csrf' });
      }
      if (String(input) === '/auth/local/login') {
        assert.equal(new Headers(init?.headers).get('X-CSRF-Token'), 'session-csrf');
        return json({ ...authenticated, user: { subject: 'local:operator', display_name: 'operator' } });
      }
      return json({ devices: [] });
    }) as typeof fetch;
    await assert.rejects(session.fetch('/device', {}, transport), AuthenticationRequired);
    assert.equal(session.state.session?.local_enabled, true);
    assert.equal(session.state.session?.user, null);
    await session.login('operator', 'local-password', transport);
    await session.fetch('/device', {}, transport);
    assert.equal(session.state.session?.user?.subject, 'local:operator');
    assert.deepEqual(calls, ['/auth/session', '/auth/local/login', '/device']);
  });

  it('discards an in-flight response from a session that was signed out', async () => {
    const session = controller();
    const pendingApi = deferred<Response>();
    const requested = deferred<void>();
    let sessionReads = 0;
    let logoutRequest: RequestInit | undefined;
    const transport = (async (input, init) => {
      if (String(input) === '/auth/session') return json(sessionReads++ === 0 ? authenticated : anonymous);
      if (String(input) === '/auth/logout') { logoutRequest = init; return new Response(null, { status: 204 }); }
      requested.resolve();
      return pendingApi.promise;
    }) as typeof fetch;
    const apiResult = session.fetch('/device', {}, transport);
    await requested.promise;
    await session.logout(transport);
    pendingApi.resolve(json({ privateData: true }));
    await assert.rejects(apiResult, AuthenticationRequired);
    assert.equal(logoutRequest?.method, 'POST');
    assert.equal(new Headers(logoutRequest?.headers).get('X-CSRF-Token'), 'session-csrf');
    assert.equal(canAccessApplication(session.state), false);
  });

  it('allows explicitly disabled authentication without requiring a login or CSRF', async () => {
    const session = controller();
    const transport = (async (input, init) => {
      if (String(input) === '/auth/session') return json({ ...anonymous, enabled: false, csrf_token: '' });
      assert.equal(new Headers(init?.headers).has('X-CSRF-Token'), false);
      return json({});
    }) as typeof fetch;
    const response = await session.fetch('/restconf/data/test', { method: 'PUT', body: '{}' }, transport);
    assert.equal(response.ok, true);
    assert.equal(canAccessApplication(session.state), true);
  });
});
