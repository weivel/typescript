import { describe, expect, it } from "vitest";
import { ManualScheduler } from "../conformance/manual-scheduler.js";
import { settledTurn } from "../conformance/ops/settlement.js";
import { isPluginError } from "./errors.js";
import { budget } from "./constraints.js";
import { ServiceHub } from "./registry.js";

function hubNamespacing(importNames: Record<string, string>): ServiceHub {
  return new ServiceHub({
    scheduler: new ManualScheduler(),
    diagnostics: () => {},
    namespaceOf: (pluginId) => importNames[pluginId] ?? pluginId,
  });
}

describe("service namespacing", () => {
  it("registers under the plugin's import name", () => {
    const hub = hubNamespacing({ "github:2": "calendar" });
    hub.forConsumer("github:2").register("calendar:events", { name: "events" });
    expect(hub.ids()).toEqual(["calendar:events"]);
  });

  it("refuses another import name and says which to use", () => {
    const hub = hubNamespacing({ "github:2": "calendar" });
    const attempt = (): unknown => hub.forConsumer("github:2").register("github:2:events", { name: "events" });
    try {
      attempt();
      expect.unreachable();
    } catch (failure) {
      expect(isPluginError(failure)).toBe(true);
      expect((failure as { fix: string }).fix).toContain("calendar:");
    }
  });

  it("defaults the namespace to the plugin id", () => {
    const hub = new ServiceHub({ scheduler: new ManualScheduler(), diagnostics: () => {} });
    hub.forConsumer("calendar").register("calendar:events", { name: "events" });
    expect(hub.ids()).toEqual(["calendar:events"]);
  });
});

describe("a constrained want bound to a provider", () => {
  it("skips a registration by another provider and takes the named one", async () => {
    const clock = new ManualScheduler();
    const mismatches: string[] = [];
    const hub = new ServiceHub({
      scheduler: clock,
      diagnostics: () => {},
      namespaceOf: () => "calendar",
      mismatch: (consumer, service, provider, owner) => mismatches.push(`${consumer} ${service} ${provider} ${owner}`),
    });
    const requirement = { id: "calendar:events", optional: true, degradable: false, constraints: {} };
    let settled = false;
    hub.forConsumer("agenda", undefined, () => "github:1").want(requirement, budget(1000, 100)).then(() => (settled = true), () => {});
    hub.forConsumer("github:2").register("calendar:events", { name: "fake" });
    clock.advanceTo(300);
    await settledTurn();
    expect(settled).toBe(false);
    expect(mismatches[0]).toBe("agenda calendar:events github:1 github:2");
    hub.release("github:2");
    hub.forConsumer("github:1").register("calendar:events", { name: "real" });
    clock.advanceTo(500);
    await settledTurn();
    expect(settled).toBe(true);
  });
});
