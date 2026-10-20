import { describe, expect, it } from "vitest";
import { budget, isPluginError, ServiceHub } from "../../src/engine/index.js";
import type { ConstraintEntry, ServiceProvider, ServiceRequirement } from "../../src/engine/index.js";
import { ManualScheduler } from "../../src/conformance/manual-scheduler.js";

const VOCABULARY: ConstraintEntry[] = [{ constraintName: "minReplicas", attributeName: "maxReplicas", bound: "lower" }];

const REPLICATED: ServiceRequirement = { id: "a:store", optional: false, degradable: false, constraints: { minReplicas: 3 } };

interface Settled {
  state: "pending" | "settled" | "rejected";
  value?: unknown;
  reason?: unknown;
}

function track(promise: Promise<unknown>): Settled {
  const settled: Settled = { state: "pending" };
  promise.then(
    (value) => Object.assign(settled, { state: "settled", value }),
    (reason) => Object.assign(settled, { state: "rejected", reason }),
  );
  return settled;
}

function turn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function hubWith(): { hub: ServiceHub; clock: ManualScheduler; reported: string[] } {
  const clock = new ManualScheduler();
  const reported: string[] = [];
  const hub = new ServiceHub({ scheduler: clock, diagnostics: (message) => reported.push(message), vocabulary: VOCABULARY });
  return { hub, clock, reported };
}

function spend(clock: ManualScheduler): void {
  for (let tick = 0; tick < 200 && clock.nextDueMillis() !== undefined; tick++) clock.fireAll();
}

function throwingAttributes(): ServiceProvider & { asked: number } {
  const provider = {
    asked: 0,
    attributes(): Record<string, number> {
      provider.asked++;
      throw new Error("attributes exploded");
    },
    serviceFor: () => "the service",
  };
  return provider;
}

describe("budget", () => {
  it("refuses an interval that never spends the budget", () => {
    expect(() => budget(1000, 0)).toThrow();
    expect(() => budget(1000, -5)).toThrow();
    expect(budget(1000, 100)).toEqual({ budgetMillis: 1000, pollMillis: 100 });
  });
});

describe("a constrained want over a provider whose attributes throw", () => {
  it("reports the throw and still ends in a refusal when not degradable", async () => {
    const { hub, clock, reported } = hubWith();
    const provider = throwingAttributes();
    hub.forConsumer("a").register("a:store", provider, { maxReplicas: 1 });
    const settled = track(hub.forConsumer("b").want(REPLICATED, budget(3000, 1000)));
    spend(clock);
    await turn();
    expect(settled.state).toBe("rejected");
    expect(isPluginError(settled.reason)).toBe(true);
    expect(reported.some((line) => line.includes("attributes exploded"))).toBe(true);
    expect(provider.asked).toBe(4);
  });

  it("reports the throw and still ends in a degrade when degradable", async () => {
    const { hub, clock, reported } = hubWith();
    hub.forConsumer("a").register("a:store", throwingAttributes(), { maxReplicas: 1 });
    const settled = track(hub.forConsumer("b").want({ ...REPLICATED, degradable: true }, budget(2000, 1000)));
    spend(clock);
    await turn();
    expect(settled.state).toBe("settled");
    expect(settled.value).toBe("the service");
    expect(reported.some((line) => line.includes("attributes exploded"))).toBe(true);
    expect(reported.some((line) => line.includes("degraded"))).toBe(true);
  });
});

describe("a constrained want released mid-budget", () => {
  it("rejects, and its provider is asked no more", async () => {
    const { hub, clock } = hubWith();
    let asked = 0;
    const provider: ServiceProvider = {
      attributes: () => {
        asked++;
        return { maxReplicas: 1 };
      },
      serviceFor: () => "the service",
    };
    hub.forConsumer("a").register("a:store", provider, null);
    const settled = track(hub.forConsumer("b").want(REPLICATED, budget(30000, 1000)));
    clock.fireAll();
    clock.fireAll();
    const askedBeforeRelease = asked;
    hub.release("b");
    spend(clock);
    await turn();
    expect(askedBeforeRelease).toBe(3);
    expect(asked).toBe(askedBeforeRelease);
    expect(clock.nextDueMillis()).toBeUndefined();
    expect(settled.state).toBe("rejected");
  });
});
