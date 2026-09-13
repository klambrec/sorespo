/** Browser-visible session metadata. OAuth credentials never enter this client. */
export interface Session {
  enabled: boolean;
  authenticated: boolean;
  oidc_enabled: boolean;
  local_enabled: boolean;
  user: { subject: string; display_name: string } | null;
  csrf_token: string;
}

export interface AuthState {
  phase: 'loading' | 'ready' | 'error';
  session: Session | null;
  message: string;
}

export const DISABLED_SESSION: Session = {
  enabled: false, authenticated: false, oidc_enabled: false,
  local_enabled: false, user: null, csrf_token: ''
};

export function canAccessApplication(state: AuthState): boolean {
  return state.phase === 'ready' && state.session !== null &&
    (!state.session.enabled || state.session.authenticated);
}

export class AuthenticationRequired extends Error {
  constructor() {
    super('Sign in to continue.');
    this.name = 'AuthenticationRequired';
  }
}

function parseSession(value: unknown): Session {
  if (!value || typeof value !== 'object') throw new Error('Invalid session response.');
  const record = value as Record<string, unknown>;
  if (['enabled', 'authenticated', 'oidc_enabled', 'local_enabled']
    .some((key) => typeof record[key] !== 'boolean') || typeof record.csrf_token !== 'string') {
    throw new Error('Invalid session response.');
  }
  let user: Session['user'] = null;
  if (record.authenticated) {
    const identity = record.user as Record<string, unknown> | null;
    if (!identity || typeof identity.subject !== 'string' || !identity.subject ||
      !record.enabled || !record.csrf_token) throw new Error('Invalid session response.');
    user = {
      subject: identity.subject,
      display_name: typeof identity.display_name === 'string' ? identity.display_name : identity.subject
    };
  }
  // Pick the documented fields explicitly. Unexpected token fields must never
  // become application state, even if a server is accidentally misconfigured.
  return {
    enabled: record.enabled as boolean,
    authenticated: record.authenticated as boolean,
    oidc_enabled: record.oidc_enabled as boolean,
    local_enabled: record.local_enabled as boolean,
    csrf_token: record.csrf_token,
    user
  };
}

/** One controller per browser tab; its CSRF token lives only in memory. */
export class SessionController {
  state: AuthState;
  private pending: Promise<Session> | null = null;
  private generation = 0;

  constructor(
    private readonly origin: () => string,
    private readonly changed: (state: AuthState) => void,
    disabled = false
  ) {
    this.state = {
      phase: disabled ? 'ready' : 'loading',
      session: disabled ? DISABLED_SESSION : null,
      message: ''
    };
  }

  private set(state: AuthState): void {
    this.state = state;
    this.changed(state);
  }

  async ensureSession(fetchFn: typeof fetch = fetch): Promise<Session> {
    if (this.state.phase === 'ready' && this.state.session) return this.state.session;
    if (this.state.phase === 'error') throw new Error(this.state.message);
    return this.refreshSession(fetchFn);
  }

  refreshSession(fetchFn: typeof fetch = fetch): Promise<Session> {
    if (this.pending) return this.pending;
    const generation = this.generation;
    this.pending = (async () => {
      try {
        const response = await fetchFn('/auth/session', {
          credentials: 'same-origin', cache: 'no-store', redirect: 'error',
          headers: { accept: 'application/json' }
        });
        if (!response.ok) throw new Error('Unable to check your session. Please try again.');
        const session = parseSession(await response.json());
        if (generation !== this.generation) throw new AuthenticationRequired();
        this.set({ phase: 'ready', session, message: this.state.message });
        return session;
      } catch (error) {
        if (generation === this.generation) {
          this.set({ phase: 'error', session: null, message: 'Unable to check your session. Please try again.' });
        }
        throw error;
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }

  /** All application requests pass here, including SvelteKit route loaders. */
  async fetch(input: RequestInfo | URL, init: RequestInit = {}, fetchFn: typeof fetch = fetch): Promise<Response> {
    const requestUrl = input instanceof Request ? input.url : String(input);
    if (new URL(requestUrl, this.origin()).origin !== this.origin()) {
      throw new Error('Application requests must use the application origin.');
    }
    const session = await this.ensureSession(fetchFn);
    if (!canAccessApplication(this.state)) throw new AuthenticationRequired();
    const generation = this.generation;
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (session.enabled && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      headers.set('X-CSRF-Token', session.csrf_token);
    }
    const response = await fetchFn(input, {
      ...init, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error'
    });
    // A response from the previous session cannot update a newly signed-in UI.
    if (generation !== this.generation) throw new AuthenticationRequired();
    if (response.status === 401 && session.enabled) {
      this.generation += 1;
      this.set({
        phase: 'loading', session: null,
        message: 'Your session has ended. Sign in to continue.'
      });
      // Obtain a fresh pre-login cookie and CSRF token without replaying the
      // original request. Replaying a write could apply the same change twice.
      void this.refreshSession(fetchFn).catch(() => {});
      throw new AuthenticationRequired();
    }
    return response;
  }

  async login(username: string, password: string, fetchFn: typeof fetch = fetch): Promise<void> {
    const session = await this.ensureSession(fetchFn);
    if (!session.enabled || !session.local_enabled || !session.csrf_token) {
      throw new Error('Local sign-in is unavailable. Refresh the sign-in page.');
    }
    const response = await fetchFn('/auth/local/login', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token },
      body: JSON.stringify({ username, password })
    });
    if (!response.ok) {
      if (response.status === 403) {
        await this.refreshSession(fetchFn);
        throw new Error('Your sign-in form expired. Please try again.');
      }
      if (response.status === 429) throw new Error('Too many sign-in attempts. Please wait and try again.');
      if (response.status === 401) throw new Error('Incorrect username or password.');
      throw new Error('Unable to sign in. Please try again.');
    }
    const authenticated = parseSession(await response.json());
    if (!authenticated.authenticated) throw new Error('Unable to sign in. Please try again.');
    this.generation += 1;
    this.set({ phase: 'ready', session: authenticated, message: '' });
  }

  async logout(fetchFn: typeof fetch = fetch): Promise<void> {
    const session = await this.ensureSession(fetchFn);
    const response = await fetchFn('/auth/logout', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'X-CSRF-Token': session.csrf_token }
    });
    if (!response.ok && response.status !== 401) throw new Error('Unable to sign out. Please try again.');
    this.generation += 1;
    this.set({ phase: 'loading', session: null, message: '' });
    await this.refreshSession(fetchFn);
  }
}
