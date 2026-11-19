import { onScopeDispose, ref } from "vue";

export const VINYL_COUNTDOWN_MS = 5000;

export function useVinylCountdown(onElapsed: () => void) {
  const seconds = ref<number | null>(null);
  const paused = ref(false);
  let remaining = VINYL_COUNTDOWN_MS;
  let last: number | null = null;
  let interval: number | undefined;

  const foreground = () => document.visibilityState === "visible" && document.hasFocus();
  const advance = (now: number) => {
    if (last !== null) remaining -= now - last;
    last = now;
  };

  const pause = () => {
    advance(performance.now());
    last = null;
    paused.value = true;
  };

  const syncFocus = () => {
    if (foreground()) {
      if (last === null) last = performance.now();
      paused.value = false;
    } else pause();
  };

  function stop() {
    if (interval !== undefined) window.clearInterval(interval);
    interval = undefined;
    seconds.value = null;
    paused.value = false;
    window.removeEventListener("focus", syncFocus);
    window.removeEventListener("blur", pause);
    document.removeEventListener("visibilitychange", syncFocus);
  }

  function start() {
    stop();
    remaining = VINYL_COUNTDOWN_MS;
    seconds.value = VINYL_COUNTDOWN_MS / 1000;
    syncFocus();
    window.addEventListener("focus", syncFocus);
    window.addEventListener("blur", pause);
    document.addEventListener("visibilitychange", syncFocus);
    interval = window.setInterval(() => {
      const now = performance.now();
      if (!foreground()) {
        pause();
        return;
      }
      advance(now);
      paused.value = false;
      if (remaining <= 0) {
        stop();
        onElapsed();
      } else seconds.value = Math.ceil(remaining / 1000);
    }, 80);
  }

  onScopeDispose(stop);
  return { seconds, paused, start, stop };
}
