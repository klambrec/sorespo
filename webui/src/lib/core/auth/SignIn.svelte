<script lang="ts">
  import { authState, session } from './session';
  import logoUrl from '$lib/assets/stratoweave-logo.png';

  let username = $state('');
  let password = $state('');
  let submitting = $state(false);
  let error = $state('');

  let oidcHref = $derived(
    typeof window === 'undefined' ? '/auth/oidc/login' :
      `/auth/oidc/login?return_to=${encodeURIComponent(window.location.pathname + window.location.search + window.location.hash)}`
  );

  async function signIn(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    submitting = true;
    error = '';
    const submittedPassword = password;
    password = '';
    try {
      await session.login(username, submittedPassword);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'Unable to sign in. Please try again.';
    } finally {
      submitting = false;
    }
  }

  async function retry(): Promise<void> {
    submitting = true;
    try {
      await session.refreshSession();
    } catch {
      // The shared session state displays the connection error.
    } finally {
      submitting = false;
    }
  }
</script>

<main class="sign-in-shell">
  <section class="sign-in-card card" aria-labelledby="sign-in-heading">
    <img src={logoUrl} alt="StratoWeave" width="286" height="53" />
    <h1 id="sign-in-heading">Sign in</h1>
    {#if $authState.phase === 'loading'}
      <p role="status">Checking your session…</p>
    {:else if $authState.phase === 'error'}
      <p role="alert">{$authState.message}</p>
      <button class="btn btn-primary" type="button" disabled={submitting} onclick={retry}>
        {submitting ? 'Checking…' : 'Try again'}
      </button>
    {:else}
      <p>{$authState.message || 'Sign in to manage your network.'}</p>
      {#if $authState.session?.oidc_enabled}
        <a class="btn btn-primary provider-login" href={oidcHref} data-sveltekit-reload>
          Sign in with OpenID Connect
        </a>
      {/if}
      {#if $authState.session?.local_enabled}
        {#if $authState.session.oidc_enabled}<div class="local-divider">Or use your local account</div>{/if}
        <form onsubmit={signIn}>
          <label for="auth-username">Username</label>
          <input id="auth-username" name="username" autocomplete="username" required bind:value={username} disabled={submitting} />
          <label for="auth-password">Password</label>
          <input id="auth-password" name="password" type="password" autocomplete="current-password" required bind:value={password} disabled={submitting} />
          {#if error}<p class="sign-in-error" role="alert">{error}</p>{/if}
          <button class="btn btn-primary" type="submit" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in with local account'}
          </button>
        </form>
      {/if}
      {#if !$authState.session?.oidc_enabled && !$authState.session?.local_enabled}
        <p role="alert">No sign-in method is available. Contact your administrator.</p>
      {/if}
    {/if}
  </section>
</main>

<style>
  .sign-in-shell {
    min-height: 100dvh;
    display: grid;
    place-items: center;
    padding: 32px 20px;
    background: var(--sw-bg-deep);
  }
  .sign-in-card { width: min(100%, 420px); padding: 36px; }
  img { max-width: 100%; height: auto; margin-bottom: 28px; }
  h1 { margin: 0 0 12px; font-size: 24px; }
  p { color: var(--sw-text-muted); margin: 0 0 24px; line-height: 1.6; }
  form { display: grid; gap: 10px; }
  label { font-size: 13px; font-weight: 600; }
  input { width: 100%; margin-bottom: 12px; }
  .provider-login { display: flex; text-align: center; }
  .local-divider { margin: 24px 0; text-align: center; color: var(--sw-text-muted); font-size: 12px; }
  .sign-in-error { margin: 0 0 10px; color: var(--sw-danger); font-size: 13px; }
</style>
