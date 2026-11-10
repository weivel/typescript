import { describe, expect, it } from "vitest";
import { ManualScheduler } from "../conformance/manual-scheduler.js";
import { isPluginError } from "./errors.js";
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
