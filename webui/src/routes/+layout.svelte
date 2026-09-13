<script lang="ts">
  import '$lib/fonts.css';
  import '../app.css';

  import { PUBLIC_DEMO } from '$env/static/public';
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount, type Component, type Snippet } from 'svelte';

  import CommandPalette from '$lib/core/command-palette/CommandPalette.svelte';
  import SignIn from '$lib/core/auth/SignIn.svelte';
  import { authState, canAccessApplication, session } from '$lib/core/auth/session';
  import { isPendingQueueItem } from '$lib/core/orchestron/client';
  import { queuesPoll, refreshQueues } from '$lib/core/orchestron/poll-store';
  import { getServiceModule, listServiceModuleMeta } from '$lib/core/registry/service-modules';
  import { formatServiceRouteId } from '$lib/core/registry/types';
  import LiveIndicator from '$lib/core/ui/LiveIndicator.svelte';
  import NavIcon from '$lib/core/ui/NavIcon.svelte';
  import { appHref, appPathname } from '$lib/core/util/nav';

  // Imported (not served from static/) so Vite inlines it as a data URI —
  // the embedded asset set must be text-only; see vite assetsInlineLimit.
  import logoUrl from '$lib/assets/stratoweave-logo.png';

  let { children }: { children?: Snippet } = $props();

  const serviceModules = listServiceModuleMeta();

  let totalPendingCount = $derived($queuesPoll.queues.filter(isPendingQueueItem).length);
  let paletteOpen = $state(false);
  let DemoShell = $state<Component | null>(null);
  let applicationMounted = $state(false);
  let restoringSession = $state(false);
  let signingOut = $state(false);
  let logoutError = $state('');
  let allowed = $derived(canAccessApplication($authState));
  let previousAccess = false;

  // Route loaders can finish with a sign-in requirement on an initial deep
  // link. Reload their data before mounting the page after authentication.
  // During expiry keep the mounted page hidden, preserving in-memory drafts;
  // existing editors already preserve dirty drafts across invalidation.
  $effect(() => {
    const access = allowed;
    if (access && !previousAccess) {
      restoringSession = true;
      void invalidateAll().catch(() => {}).finally(() => {
        if (canAccessApplication(session.state)) applicationMounted = true;
        restoringSession = false;
      });
    } else if (!access) {
      paletteOpen = false;
    }
    previousAccess = access;
  });

  async function handleLogout(): Promise<void> {
    if (signingOut) return;
    signingOut = true;
    logoutError = '';
    try {
      await session.logout();
    } catch (error) {
      logoutError = error instanceof Error ? error.message : 'Unable to sign out. Please try again.';
    } finally {
      // Explicit logout discards mounted private data and drafts.
      if (!canAccessApplication(session.state)) applicationMounted = false;
      signingOut = false;
    }
  }

  onMount(() => {
    void session.ensureSession().catch(() => {});
    // Statically false outside demo builds, so the chunk is never emitted.
    if (PUBLIC_DEMO === '1') {
      void import('$lib/demo/DemoShell.svelte').then((mod) => {
        DemoShell = mod.default;
      });
    }
  });

  async function handleRefresh(): Promise<void> {
    if (!allowed) return;
    window.dispatchEvent(new CustomEvent('global-refresh'));
    await Promise.all([refreshQueues(), invalidateAll()]);
  }

  onMount(() => {
    const handler = (event: KeyboardEvent) => {
      if (!allowed) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        paletteOpen = !paletteOpen;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  function decodePathSegment(value: string): string {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function capitalize(value: string): string {
    if (!value) return value;
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  type Crumb = { label: string; href: string; current: boolean };

  // Static route-segment labels; anything not listed falls back to
  // capitalize() plus the dynamic rules below (module titles, service ids,
  // device names).
  const SEGMENT_LABELS: Record<string, string> = {
    services: 'Services',
    devices: 'Devices',
    operations: 'Operations',
    'config-queue': 'Config Queue',
    'global-settings': 'Global Settings',
    layers: 'Layer configuration',
    configure: 'Apply Config',
    new: 'New'
  };

  /** Map a URL path to a friendly, clickable breadcrumb. */
  function getBreadcrumbs(pathname: string): Crumb[] {
    const parts = pathname.split('/').filter(Boolean).map(decodePathSegment);
    if (parts.length === 0) return [{ label: 'Dashboard', href: '/', current: true }];

    const crumbs: Crumb[] = [];
    let href = '';

    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      href += `/${encodeURIComponent(part)}`;

      let label = SEGMENT_LABELS[part] ?? capitalize(part);

      if (parts[0] === 'services' && i === 1) {
        label = getServiceModule(part)?.title ?? part;
      } else if (parts[0] === 'services' && i === 2 && part !== 'new') {
        const module = getServiceModule(parts[1]);
        label = module ? formatServiceRouteId(module, part) : part;
      } else if (parts[0] === 'devices' && i === 1) {
        label = part;
      }

      crumbs.push({ label, href, current: i === parts.length - 1 });
    }

    return crumbs;
  }

  let currentPathname = $derived(appPathname(page.url));

  function ariaCurrent(active: boolean): 'page' | undefined {
    return active ? 'page' : undefined;
  }
  let breadcrumbs = $derived(getBreadcrumbs(currentPathname));
  let pageTitle = $derived(
    breadcrumbs
      .slice()
      .reverse()
      .map((seg) => seg.label)
      .concat('StratoWeave')
      .join(' · ')
  );
</script>

<svelte:head>
  <title>{pageTitle}</title>
</svelte:head>

{#if !allowed}
  <SignIn />
{:else if restoringSession || !applicationMounted}
  <main class="session-loading" role="status">Loading your workspace…</main>
{/if}

{#if applicationMounted}
<div class="authenticated-workspace" hidden={!allowed || restoringSession} inert={!allowed || restoringSession}>
<div class="app-shell">
  <!-- Sidebar -->
  <aside class="sidebar">
    <div class="sidebar-logo">
      <a class="logo-link" href={appHref('/')} aria-label="StratoWeave — go to dashboard">
        <img
          class="logo-img"
          src={logoUrl}
          alt="StratoWeave — Orchestration Platform"
          width="286"
          height="53"
        />
      </a>
    </div>
    <nav class="sidebar-nav" aria-label="Primary navigation">
      <div class="nav-section">
        <a
          class="nav-item"
          class:active={currentPathname === '/'}
          aria-current={ariaCurrent(currentPathname === '/')}
          href={appHref('/')}
          data-tour="nav-dashboard"
        >
          <span class="nav-icon"><NavIcon name="dashboard" /></span>
          Dashboard
        </a>
        <a
          class="nav-item"
          class:active={currentPathname.startsWith('/devices')}
          aria-current={ariaCurrent(currentPathname.startsWith('/devices'))}
          href={appHref('/devices')}
          data-tour="nav-devices"
        >
          <span class="nav-icon"><NavIcon name="devices" /></span>
          Devices
        </a>
      </div>

      <div class="nav-section">
        <div class="nav-section-label">Operations</div>
        <a
          class="nav-item"
          class:active={currentPathname.startsWith('/operations/config-queue')}
          aria-current={ariaCurrent(currentPathname.startsWith('/operations/config-queue'))}
          href={appHref('/operations/config-queue')}
          data-tour="nav-queue"
        >
          <span class="nav-icon"><NavIcon name="queue" /></span>
          Config Queue
          {#if totalPendingCount > 0}
            <span class="nav-badge">{totalPendingCount}</span>
          {/if}
        </a>
        <a
          class="nav-item"
          class:active={currentPathname.startsWith('/configure')}
          aria-current={ariaCurrent(currentPathname.startsWith('/configure'))}
          href={appHref('/configure')}
          data-tour="nav-configure"
        >
          <span class="nav-icon"><NavIcon name="apply" /></span>
          Apply Config
        </a>
        <a
          class="nav-item"
          class:active={currentPathname.startsWith('/layers')}
          aria-current={ariaCurrent(currentPathname.startsWith('/layers'))}
          href={appHref('/layers')}
          data-tour="nav-layers"
        >
          <span class="nav-icon"><NavIcon name="layers" /></span>
          Layer configuration
        </a>
      </div>

      <div class="nav-section">
        <div class="nav-section-label">Services</div>
        <a
          class="nav-item"
          class:active={currentPathname.startsWith('/services')}
          aria-current={ariaCurrent(currentPathname.startsWith('/services'))}
          href={appHref('/services')}
          data-tour="nav-services"
        >
          <span class="nav-icon"><NavIcon name="services" /></span>
          Service Modules
        </a>

        <div class="nav-subsection">
          {#each serviceModules as serviceModule (serviceModule.id)}
            <a
              class="nav-item nav-item--sub"
              class:active={currentPathname.startsWith(`/services/${serviceModule.id}`)}
              aria-current={ariaCurrent(currentPathname.startsWith(`/services/${serviceModule.id}`))}
              href={appHref(`/services/${serviceModule.id}`)}
            >
              {serviceModule.title}
            </a>
          {/each}

          <a
            class="nav-item nav-item--sub"
            class:active={currentPathname.startsWith('/global-settings')}
            aria-current={ariaCurrent(currentPathname.startsWith('/global-settings'))}
            href={appHref('/global-settings')}
            data-tour="nav-global-settings"
          >
            <span class="nav-icon"><NavIcon name="settings" /></span>
            Global Settings
          </a>
        </div>
      </div>
    </nav>
  </aside>

  <!-- Main area -->
  <div class="app-main-wrap">
    <header class="app-header">
      <nav class="yang-path" aria-label="Breadcrumb">
        {#each breadcrumbs as crumb, i}
          {#if i > 0}
            <span class="separator">›</span>
          {/if}
          {#if crumb.current}
            <span class="segment current" aria-current="page">{crumb.label}</span>
          {:else}
            <a class="segment" href={appHref(crumb.href)}>{crumb.label}</a>
          {/if}
        {/each}
      </nav>

      <div class="header-actions">
        {#if $authState.session?.authenticated}
          <span class="session-user" title={$authState.session.user?.subject}>
            {$authState.session.user?.display_name || $authState.session.user?.subject}
          </span>
          <button class="btn btn-ghost btn-sm" type="button" onclick={handleLogout} disabled={signingOut}>
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        {/if}
        <LiveIndicator />
        <button class="btn btn-ghost btn-sm cmdk-trigger" type="button" onclick={() => (paletteOpen = true)} aria-label="Open command palette">
          Search <kbd>⌘K</kbd>
        </button>
        <button class="btn btn-ghost btn-sm" type="button" onclick={handleRefresh} data-tour="refresh">
          <NavIcon name="refresh" /> Refresh
        </button>
      </div>
    </header>

    <main class="app-content">
      {#if logoutError}<p class="logout-error" role="alert">{logoutError}</p>{/if}
      {#key currentPathname}
        <div class="page-enter">
          {@render children?.()}
        </div>
      {/key}
    </main>
  </div>
</div>

<CommandPalette bind:open={paletteOpen} />

{#if DemoShell}
  <DemoShell />
{/if}
</div>
{/if}

<style>
  .authenticated-workspace[hidden] { display: none; }
  .session-loading { min-height: 100dvh; display: grid; place-items: center; color: var(--sw-text-muted); }
  .session-user { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--sw-text-muted); }
  .logout-error { color: var(--sw-danger); }
  .nav-subsection {
    display: grid;
    gap: 2px;
    margin-top: 4px;
    padding-left: 12px;
  }

  .nav-item--sub {
    font-size: 12px;
    padding-left: 28px;
    color: var(--sw-text-muted);
  }

  .nav-item--sub .nav-icon {
    margin-left: -28px;
  }

  .cmdk-trigger {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .cmdk-trigger kbd {
    display: inline-block;
    padding: 1px 5px;
    border: 1px solid var(--sw-border-subtle);
    border-radius: 4px;
    background: var(--sw-bg-card);
    font-family: var(--sw-font-mono);
    font-size: 11px;
    color: var(--sw-text-muted);
  }

  @media (max-width: 960px) {
    .nav-subsection {
      display: contents;
    }

    .nav-item--sub {
      padding-left: 12px;
    }

    .nav-item--sub .nav-icon {
      margin-left: 0;
    }
  }
</style>
