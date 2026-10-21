import { afterEach, describe, expect, it, vi } from "vitest";
import { REAL_TIME } from "../../src/engine/index.js";

describe("REAL_TIME", () => {
  it("is frozen, so no caller can swap the clock every host defaults to", () => {
    expect(Object.isFrozen(REAL_TIME)).toBe(true);
  });

  describe("a long delay", () => {
    afterEach(() => vi.useRealTimers());

    it("does not fire before the whole delay has elapsed", () => {
      vi.useFakeTimers();
      let ran = false;
      REAL_TIME.schedule(() => { ran = true; }, 2 ** 32);
      vi.advanceTimersByTime(2 ** 31);
      expect(ran).toBe(false);
      vi.advanceTimersByTime(2 ** 32 - 2 ** 31);
      expect(ran).toBe(true);
    });

    it("is cancelled by disposing mid-chain", () => {
      vi.useFakeTimers();
      let ran = false;
      const dispose = REAL_TIME.schedule(() => { ran = true; }, 2 ** 32);
      vi.advanceTimersByTime(2 ** 31);
      dispose();
      vi.advanceTimersByTime(2 ** 33);
      expect(ran).toBe(false);
    });

    it("never runs for an infinite or NaN delay, and its disposer is harmless", () => {
      vi.useFakeTimers();
      let ran = false;
      const disposers = [Infinity, NaN].map((delay) => REAL_TIME.schedule(() => { ran = true; }, delay));
      vi.advanceTimersByTime(2 ** 33);
      disposers.forEach((dispose) => dispose());
      expect(ran).toBe(false);
    });
  });
});
