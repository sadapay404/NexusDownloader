import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { effectScope } from "vue";
import { useVinylCountdown } from "@/composables/useVinylCountdown";

let focused = true;
let scope = effectScope();

beforeEach(() => {
  focused = true;
  scope = effectScope();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  const eventTarget = new EventTarget();
  vi.stubGlobal("window", Object.assign(eventTarget, { setInterval, clearInterval }));
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), {
      hasFocus: () => focused,
      visibilityState: "visible",
    }),
  );
});

afterEach(() => {
  scope.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function countdown() {
  const elapsed = vi.fn();
  const state = scope.run(() => useVinylCountdown(elapsed))!;
  return { elapsed, ...state };
}

test("starts at five, then fires once after five foreground seconds", () => {
  const { seconds, start, elapsed } = countdown();
  start();
  expect(seconds.value).toBe(5);
  vi.advanceTimersByTime(1040);
  expect(seconds.value).toBe(4);
  vi.advanceTimersByTime(3959);
  expect(elapsed).not.toHaveBeenCalled();
  vi.advanceTimersByTime(90);
  expect(elapsed).toHaveBeenCalledTimes(1);
  expect(seconds.value).toBeNull();
  vi.advanceTimersByTime(8000);
  expect(elapsed).toHaveBeenCalledTimes(1);
});

test("clears the countdown immediately when cancelled", () => {
  const { seconds, start, stop, elapsed } = countdown();
  start();
  vi.advanceTimersByTime(1000);
  stop();
  expect(seconds.value).toBeNull();
  vi.advanceTimersByTime(8000);
  expect(elapsed).not.toHaveBeenCalled();
});

test("focus loss does not spend any of the remaining time", () => {
  const { paused, start, elapsed } = countdown();
  start();
  vi.advanceTimersByTime(2000);
  focused = false;
  window.dispatchEvent(new Event("blur"));
  vi.advanceTimersByTime(10_000);
  expect(paused.value).toBe(true);
  expect(elapsed).not.toHaveBeenCalled();
  focused = true;
  window.dispatchEvent(new Event("focus"));
  expect(paused.value).toBe(false);
  vi.advanceTimersByTime(2999);
  expect(elapsed).not.toHaveBeenCalled();
  vi.advanceTimersByTime(81);
  expect(elapsed).toHaveBeenCalledTimes(1);
});

test("unmounting the view clears its timer and prevents a stale download", () => {
  const { seconds, start, elapsed } = countdown();
  start();
  scope.stop();
  expect(seconds.value).toBeNull();
  vi.advanceTimersByTime(8000);
  expect(elapsed).not.toHaveBeenCalled();
});
