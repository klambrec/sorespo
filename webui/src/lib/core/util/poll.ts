import { browser } from '$app/environment';
import { authState, canAccessApplication } from '$lib/core/auth/session';

/**
 * Run `task` every `intervalMs` while the tab is visible. A tick is skipped
 * while the previous run is still in flight, and a run is triggered as soon
 * as the tab becomes visible again. Returns a stop function. Does nothing
 * on the server.
 */
export function startPolling(
  task: () => Promise<unknown> | unknown,
  intervalMs: number,
  { immediate = true }: { immediate?: boolean } = {}
): () => void {
  if (!browser) return () => {};

  let inFlight = false;
  let stopped = false;
  let allowed = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const run = async (): Promise<void> => {
    if (inFlight || stopped || !allowed) return;
    inFlight = true;
    try {
      await task();
    } finally {
      inFlight = false;
    }
  };

  const tick = (): void => {
    if (document.visibilityState === 'hidden') return;
    void run();
  };

  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') void run();
  };

  let firstActivation = true;
  const unsubscribe = authState.subscribe((state) => {
    const nextAllowed = canAccessApplication(state);
    if (nextAllowed === allowed) return;
    allowed = nextAllowed;
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (allowed) {
      if (immediate || !firstActivation) tick();
      firstActivation = false;
      timer = setInterval(tick, intervalMs);
    }
  });
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    stopped = true;
    if (timer !== null) clearInterval(timer);
    unsubscribe();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
