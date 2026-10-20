import { describe, expect, it } from "vitest";
import { ManualScheduler } from "../../src/conformance/manual-scheduler.js";

describe("ManualScheduler", () => {
  it("runs due ticks earliest first and sets the clock to each", () => {
    const scheduler = new ManualScheduler();
    const seen: Array<[string, number]> = [];
    scheduler.schedule(() => seen.push(["late", scheduler.now()]), 20);
    scheduler.schedule(() => seen.push(["early", scheduler.now()]), 10);
    scheduler.advanceTo(30);
    expect(seen).toEqual([["early", 10], ["late", 20]]);
    expect(scheduler.now()).toBe(30);
  });

  it("does not run a cancelled tick, and fireAll leaves the clock where it was", () => {
    const scheduler = new ManualScheduler();
    const seen: string[] = [];
    const cancel = scheduler.schedule(() => seen.push("cancelled"), 5);
    scheduler.schedule(() => seen.push("kept"), 500);
    cancel();
    scheduler.fireAll();
    expect(seen).toEqual(["kept"]);
    expect(scheduler.now()).toBe(0);
  });
});
