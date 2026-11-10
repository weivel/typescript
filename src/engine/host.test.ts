import { describe, expect, it } from "vitest";
import { ManualScheduler } from "../conformance/manual-scheduler.js";
import type { ManifestRequirement, PluginContext, PluginManifest } from "../index.js";
import { createHost } from "./host.js";
import type { Host } from "./host.js";
import type { PluginRuntime } from "./context.js";

const SILENT: PluginRuntime = {
  config: { all: () => ({}), get: () => undefined, set: async () => {} },
  log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  paths: { cache: "", config: "", home: "", plugin: "", repos: "" },
  events: { publish: () => {}, subscribe: () => () => {} },
};

function manifest(id: string, importName: string, consumes: (string | ManifestRequirement)[], provides: string[]): PluginManifest {
  return { id, importName, name: importName, api: 1, services: { consumes, provides } };
}

function newHost(diagnostics: string[] = []): Host {
  return createHost({ app: "", applications: [], scheduler: new ManualScheduler(), diagnostics: (line) => diagnostics.push(line) });
}

function providerOfEvents(host: Host, id: string, importName: string): PluginContext {
  const context = host.contextFor(manifest(id, importName, [], ["calendar:events"]), SILENT);
  context.services.register(context.service("calendar:events"), { name: () => "events" });
  return context;
}

function consumerBoundTo(host: Host, provider: string | undefined): PluginContext {
  const requirement: ManifestRequirement = provider === undefined ? { id: "calendar:events" } : { id: "calendar:events", provider };
  return host.contextFor(manifest("agenda", "agenda", [requirement], []), SILENT);
}

describe("a bound service", () => {
  it("is served by the provider it names", () => {
    const host = newHost();
    providerOfEvents(host, "github:2", "calendar");
    const consumer = consumerBoundTo(host, "github:2");
    expect(consumer.services.get(consumer.service("calendar:events"))).toBeDefined();
  });

  it("is refused when another provider owns it, naming both ids", () => {
    const diagnostics: string[] = [];
    const host = newHost(diagnostics);
    providerOfEvents(host, "github:2", "calendar");
    const consumer = consumerBoundTo(host, "github:1");
    expect(consumer.services.get(consumer.service("calendar:events"))).toBeUndefined();
    expect(host.ledger.refusals()).toEqual([{ pluginId: "agenda", serviceId: "calendar:events" }]);
    expect(diagnostics.join("\n")).toContain("github:1");
    expect(diagnostics.join("\n")).toContain("github:2");
  });

  it("reads as absent, not refused, when nobody provides it", () => {
    const host = newHost();
    const consumer = consumerBoundTo(host, "github:1");
    expect(consumer.services.get(consumer.service("calendar:events"))).toBeUndefined();
    expect(host.ledger.refusals()).toEqual([]);
  });

  it("is served from anyone when the consumer names no provider", () => {
    const host = newHost();
    providerOfEvents(host, "github:2", "calendar");
    const consumer = consumerBoundTo(host, undefined);
    expect(consumer.services.get(consumer.service("calendar:events"))).toBeDefined();
    expect(host.ledger.refusals()).toEqual([]);
  });
});
