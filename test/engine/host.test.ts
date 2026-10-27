import { describe, expect, it } from "vitest";
import { createHost, isPluginError, pluginError } from "../../src/engine/index.js";
import type { HostOptions, PluginRuntime, RuntimeEvents } from "../../src/engine/index.js";
import type { PluginContext, PluginManifest } from "../../src/index.js";
import { ManualScheduler } from "../../src/conformance/manual-scheduler.js";

function bus(): RuntimeEvents & { listeners: Map<string, Set<(payload: unknown) => void>> } {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    listeners,
    publish: (topic, payload) => {
      for (const listener of listeners.get(topic) ?? []) listener(payload);
    },
    subscribe: (topic, listener) => {
      const installed = listeners.get(topic) ?? new Set();
      installed.add(listener);
      listeners.set(topic, installed);
      return () => installed.delete(listener);
    },
  };
}

function runtime(events: RuntimeEvents = bus()): PluginRuntime {
  return {
    config: { all: () => ({}), get: () => undefined, set: async () => {} },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    paths: { cache: "c", config: "f", home: "h", plugin: "p", repos: "r" },
    events,
  };
}

function hostWith(options: Partial<HostOptions> = {}): { host: ReturnType<typeof createHost>; reported: string[] } {
  const reported: string[] = [];
  const host = createHost({
    app: "claude",
    scheduler: new ManualScheduler(),
    diagnostics: (message) => reported.push(message),
    ...options,
  });
  return { host, reported };
}

const PROVIDER: PluginManifest = { id: "a", api: 2, capabilities: ["screens"] };

describe("two hosts in one process", () => {
  it("share neither services nor diagnostics", () => {
    const first = hostWith();
    const second = hostWith();
    const context = first.host.contextFor(PROVIDER, runtime());
    context.services.register(context.service("a:x"), { name: "x" });
    first.host.provideService("host:y", { name: "y" });
    expect(first.host.service("a:x")).toBeDefined();
    expect(second.host.service("a:x")).toBeUndefined();
    expect(second.host.service("host:y")).toBeUndefined();
    first.host.markBroken("a", pluginError("a", "broke", "mend it"));
    context.services.register(context.service("a:late"), {});
    expect(first.reported.some((line) => line.includes("a:late"))).toBe(true);
    expect(second.reported).toEqual([]);
    const later = second.host.contextFor({ id: "b", api: 2 }, runtime());
    second.host.release("b");
    later.services.register(later.service("b:late"), {});
    expect(second.reported.some((line) => line.includes("b:late"))).toBe(true);
    expect(first.reported.some((line) => line.includes("b:late"))).toBe(false);
  });
});

describe("contextFor", () => {
  it("is a PluginContext whose manifest is the argument itself", () => {
    const { host } = hostWith();
    const context: PluginContext = host.contextFor(PROVIDER, runtime());
    expect(context.manifest).toBe(PROVIDER);
    expect(context.host).toEqual({ api: 2, app: "claude", surfaces: [] });
  });

  it("records a subscription and releases it with the plugin", () => {
    const { host } = hostWith();
    const events = bus();
    const context = host.contextFor(PROVIDER, runtime(events));
    const heard: unknown[] = [];
    context.events.subscribe(context.topic<string>("a:ping"), (value) => heard.push(value));
    events.publish("a:ping", "one");
    expect(host.ledger.entry("a")?.topics).toEqual(["a:ping"]);
    host.release("a");
    events.publish("a:ping", "two");
    expect(heard).toEqual(["one"]);
    expect(host.ledger.entry("a")?.status).toBe("stopped");
  });

  it("asks the runtime for homes on each call", () => {
    const { host } = hostWith();
    let calls = 0;
    const context = host.contextFor(PROVIDER, {
      ...runtime(),
      homes: {
        all: () => {
          calls++;
          return [];
        },
      },
    });
    context.homes();
    context.homes();
    expect(calls).toBe(2);
    expect(host.contextFor({ id: "b", api: 2 }, runtime()).homes()).toEqual([]);
  });
});

describe("the fence", () => {
  it("makes a register after markBroken inert, and reports it", () => {
    const { host, reported } = hostWith();
    const context = host.contextFor(PROVIDER, runtime());
    host.markBroken("a", pluginError("a", "broke", "mend it"));
    const dispose = context.services.register(context.service("a:x"), { name: "x" });
    expect(host.service("a:x")).toBeUndefined();
    expect(() => dispose()).not.toThrow();
    expect(reported.some((line) => line.includes("a:x") && line.includes("no longer running"))).toBe(true);
    expect(host.ledger.entry("a")?.error).toEqual({ detail: "broke", fix: "mend it" });
  });

  it("rejects a want after release", async () => {
    const { host } = hostWith();
    const context = host.contextFor(PROVIDER, runtime());
    host.release("a");
    await expect(context.services.want(context.service("b:x"))).rejects.toSatisfy(isPluginError);
  });
});

describe("a consumer reaches only what it declared", () => {
  const PROVIDING: PluginManifest = { id: "calendar", api: 2, services: { provides: ["calendar:events"] } };
  const UNDECLARED: PluginManifest = { id: "notes", api: 2 };
  const DECLARING: PluginManifest = { id: "agenda", api: 2, services: { consumes: ["calendar:events", "clock"] } };

  function registered(host: ReturnType<typeof createHost>): void {
    const provider = host.contextFor(PROVIDING, runtime());
    provider.services.register(provider.service("calendar:events"), { name: "events" });
  }

  it("answers nothing to an undeclared get and records the refusal once", () => {
    const { host, reported } = hostWith();
    registered(host);
    const notes = host.contextFor(UNDECLARED, runtime());
    expect(notes.services.get(notes.service("calendar:events"))).toBeUndefined();
    expect(notes.services.get(notes.service("calendar:events"))).toBeUndefined();
    expect(host.ledger.refusals()).toEqual([{ pluginId: "notes", serviceId: "calendar:events" }]);
    const lines = reported.filter((line) => line.includes("calendar:events"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("notes");
    expect(lines[0]).toContain("services.consumes");
  });

  it("refuses a host service the plugin did not declare", () => {
    const { host } = hostWith();
    host.provideService("clock", { now: () => 0 });
    const notes = host.contextFor(UNDECLARED, runtime());
    const agenda = host.contextFor(DECLARING, runtime());
    expect(notes.services.get(notes.service("clock"))).toBeUndefined();
    expect(agenda.services.get(agenda.service("clock"))).toBeDefined();
    expect(host.ledger.refusals()).toEqual([{ pluginId: "notes", serviceId: "clock" }]);
  });

  it("rejects an undeclared want with the fix rather than the late wording", async () => {
    const { host } = hostWith();
    registered(host);
    const notes = host.contextFor(UNDECLARED, runtime());
    const refusal: unknown = await notes.services.want(notes.service("calendar:events")).catch((failure: unknown) => failure);
    expect(isPluginError(refusal)).toBe(true);
    expect((refusal as { fix: string }).fix).toContain("services.consumes");
    expect((refusal as { detail: string }).detail).not.toContain("stopped");
    expect(host.ledger.refusals()).toEqual([{ pluginId: "notes", serviceId: "calendar:events" }]);
  });

  it("keeps an undeclared watch inert", () => {
    const { host } = hostWith();
    const notes = host.contextFor(UNDECLARED, runtime());
    const heard: unknown[] = [];
    notes.services.watch(notes.service("calendar:events"), (service) => heard.push(service));
    registered(host);
    expect(heard).toEqual([]);
    expect(host.ledger.refusals()).toEqual([{ pluginId: "notes", serviceId: "calendar:events" }]);
  });

  it("serves what a plugin consumes or provides, and reads a declared id nothing provides as absence", async () => {
    const { host } = hostWith();
    const agenda = host.contextFor(DECLARING, runtime());
    expect(agenda.services.get(agenda.service("calendar:events"))).toBeUndefined();
    const provider = host.contextFor(PROVIDING, runtime());
    provider.services.register(provider.service("calendar:events"), { name: "events" });
    expect(provider.services.get(provider.service("calendar:events"))).toBeDefined();
    await expect(agenda.services.want(agenda.service("calendar:events"))).resolves.toBeDefined();
    expect(host.ledger.refusals()).toEqual([]);
  });

  it("refuses a revoked plugin's undeclared call as undeclared, and only its declared want as late", async () => {
    const { host, reported } = hostWith();
    const agenda = host.contextFor({ id: "agenda", api: 2, services: { consumes: ["clock"] } }, runtime());
    host.release("agenda");
    const undeclared: unknown = await agenda.services.want(agenda.service("calendar:events")).catch((failure: unknown) => failure);
    agenda.services.watch(agenda.service("locale"), () => {});
    const declared: unknown = await agenda.services.want(agenda.service("clock")).catch((failure: unknown) => failure);
    expect(host.ledger.refusals()).toEqual([
      { pluginId: "agenda", serviceId: "calendar:events" },
      { pluginId: "agenda", serviceId: "locale" },
    ]);
    expect((undeclared as { fix: string }).fix).toContain("services.consumes");
    expect((declared as { detail: string }).detail).toContain("stopped while waiting");
    expect(reported.some((line) => line.includes("locale") && line.includes("services.consumes"))).toBe(true);
  });

  it("lists only the registered ids a plugin may reach, without reporting the rest", () => {
    const { host, reported } = hostWith();
    host.provideService("clock", {});
    host.provideService("locale", {});
    registered(host);
    const agenda = host.contextFor(DECLARING, runtime());
    const notes = host.contextFor(UNDECLARED, runtime());
    expect([...agenda.services.ids()].sort()).toEqual(["calendar:events", "clock"]);
    expect(notes.services.ids()).toEqual([]);
    expect(host.ledger.refusals()).toEqual([]);
    expect(reported).toEqual([]);
  });
});

describe("verifyActivation", () => {
  it("refuses a capability declared and never provided", () => {
    const { host } = hostWith();
    host.contextFor(PROVIDER, runtime());
    const refusal = host.verifyActivation(PROVIDER);
    expect(isPluginError(refusal)).toBe(true);
    expect(refusal?.detail).toContain("screens");
    expect(host.ledger.entry("a")?.status).toBe("activating");
  });

  it("marks the plugin active once declared and provided agree", () => {
    const { host } = hostWith();
    const context = host.contextFor(PROVIDER, runtime());
    const screens = { render: () => "x" };
    context.provide(context.capability<typeof screens>("screens"), screens);
    expect(host.verifyActivation(PROVIDER)).toBeNull();
    expect(host.ledger.entry("a")?.status).toBe("active");
    expect(host.capability("screens")).toEqual([{ pluginId: "a", implementation: screens }]);
  });

  it("refuses a capability provided twice", () => {
    const { host } = hostWith();
    const context = host.contextFor(PROVIDER, runtime());
    context.provide(context.capability("screens"), {});
    expect(() => context.provide(context.capability("screens"), {})).toThrow(/twice/);
  });

  it("reports a capability outside a declared vocabulary", () => {
    const { host, reported } = hostWith({ vocabulary: ["tools"] });
    const context = host.contextFor(PROVIDER, runtime());
    context.provide(context.capability("screens"), {});
    expect(reported.some((line) => line.includes("screens"))).toBe(true);
  });
});

describe("applications", () => {
  const elsewhere: PluginManifest = { id: "t", api: 2, targets: ["forebay"] };

  it("takes the app as the one application when absent", () => {
    expect(hostWith().host.supports(elsewhere)).not.toBeNull();
  });

  it("hosts every application when explicitly empty", () => {
    expect(hostWith({ applications: [] }).host.supports(elsewhere)).toBeNull();
  });
});
