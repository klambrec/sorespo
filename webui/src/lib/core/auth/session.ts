import { browser } from '$app/environment';
import { PUBLIC_DEMO } from '$env/static/public';
import { writable } from 'svelte/store';
import { demoFetch } from '$lib/demo/gate';
import { AuthenticationRequired, SessionController, type AuthState } from './controller';

export { canAccessApplication } from './controller';

const state = writable<AuthState>({ phase: 'loading', session: null, message: '' });
export const session = new SessionController(
  () => window.location.origin,
  (next) => state.set(next),
  PUBLIC_DEMO === '1'
);
state.set(session.state);
export const authState = { subscribe: state.subscribe };

export async function authenticatedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  fetchFn: typeof fetch = fetch
): Promise<Response> {
  if (demoFetch) return demoFetch(input, init);
  // Production is a static SPA: build-time rendering must never fetch private
  // data or put a user's session into shared server state.
  if (!browser) throw new AuthenticationRequired();
  return session.fetch(input, init, fetchFn);
}
