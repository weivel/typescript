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

const PROVIDER: PluginManifest = { id: "a", name: "a", importName: "a", api: 2, capabilities: { provides: ["screens"] } };

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
    const later = second.host.contextFor({ id: "b", name: "b", importName: "b", api: 2 }, runtime());
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
    expect(host.contextFor({ id: "b", name: "b", importName: "b", api: 2 }, runtime()).homes()).toEqual([]);
  });

  it("leaves secrets and the portable path absent on a host that offers neither", () => {
    const { host } = hostWith();
    const context = host.contextFor(PROVIDER, runtime());
    expect("secrets" in context).toBe(false);
    expect("portable" in context.paths).toBe(false);
  });

  it("hands over the runtime's secrets and portable path by identity", () => {
    const { host } = hostWith();
    const secrets = { get: async () => "token", set: async () => {}, delete: async () => {} };
    const offered = runtime();
    const paths = { ...offered.paths, portable: "/portable/a" };
    const context = host.contextFor(PROVIDER, { ...offered, paths, secrets });
    expect(context.secrets).toBe(secrets);
    expect(context.paths).toBe(paths);
  });

  it("refuses a portable write without the layer and hands the runtime nothing", async () => {
    const { host } = hostWith();
    const layers: unknown[] = [];
    const offered = runtime();
    const config = { ...offered.config, set: async (_key: string, _value: unknown, options?: unknown) => void layers.push(options) };
    const context = host.contextFor(PROVIDER, { ...offered, config });
    await expect(context.config.set("theme", "dark", { layer: "portable" })).rejects.toMatchObject({
      detail: "this host has no portable settings layer",
    });
    await context.config.set("theme", "dark");
    await context.config.set("theme", "dark", { layer: "application" });
    expect(layers).toEqual([undefined, { layer: "application" }]);
  });

  it("passes a portable write through on a host with the layer", async () => {
    const { host } = hostWith();
    const layers: unknown[] = [];
    const offered = runtime();
    const config = { ...offered.config, set: async (_key: string, _value: unknown, options?: unknown) => void layers.push(options) };
    const paths = { ...offered.paths, portable: "/portable/a" };
    await host.contextFor(PROVIDER, { ...offered, config, paths }).config.set("theme", "dark", { layer: "portable" });
    expect(layers).toEqual([{ layer: "portable" }]);
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
  const PROVIDING: PluginManifest = { id: "calendar", name: "calendar", importName: "calendar", api: 2, services: { provides: ["calendar:events"] } };
  const UNDECLARED: PluginManifest = { id: "notes", name: "notes", importName: "notes", api: 2 };
  const DECLARING: PluginManifest = { id: "agenda", name: "agenda", importName: "agenda", api: 2, services: { consumes: ["calendar:events", "clock"] } };

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
    expect(host.ledger.refusals()).toEqual([{ kind: "service", pluginId: "notes", id: "calendar:events" }]);
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
    expect(host.ledger.refusals()).toEqual([{ kind: "service", pluginId: "notes", id: "clock" }]);
  });

  it("rejects an undeclared want with the fix rather than the late wording", async () => {
    const { host } = hostWith();
    registered(host);
    const notes = host.contextFor(UNDECLARED, runtime());
    const refusal: unknown = await notes.services.want(notes.service("calendar:events")).catch((failure: unknown) => failure);
    expect(isPluginError(refusal)).toBe(true);
    expect((refusal as { fix: string }).fix).toContain("services.consumes");
    expect((refusal as { detail: string }).detail).not.toContain("stopped");
    expect(host.ledger.refusals()).toEqual([{ kind: "service", pluginId: "notes", id: "calendar:events" }]);
  });

  it("keeps an undeclared watch inert", () => {
    const { host } = hostWith();
    const notes = host.contextFor(UNDECLARED, runtime());
    const heard: unknown[] = [];
    notes.services.watch(notes.service("calendar:events"), (service) => heard.push(service));
    registered(host);
    expect(heard).toEqual([]);
    expect(host.ledger.refusals()).toEqual([{ kind: "service", pluginId: "notes", id: "calendar:events" }]);
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
    const agenda = host.contextFor({ id: "agenda", name: "agenda", importName: "agenda", api: 2, services: { consumes: ["clock"] } }, runtime());
    host.release("agenda");
    const undeclared: unknown = await agenda.services.want(agenda.service("calendar:events")).catch((failure: unknown) => failure);
    agenda.services.watch(agenda.service("locale"), () => {});
    const declared: unknown = await agenda.services.want(agenda.service("clock")).catch((failure: unknown) => failure);
    expect(host.ledger.refusals()).toEqual([
      { kind: "service", pluginId: "agenda", id: "calendar:events" },
      { kind: "service", pluginId: "agenda", id: "locale" },
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

  it("reports a refusal once for the life of the host, across a restart of the plugin", () => {
    const { host, reported } = hostWith();
    registered(host);
    const before = host.contextFor(UNDECLARED, runtime());
    expect(before.services.get(before.service("calendar:events"))).toBeUndefined();
    host.release("notes");
    const after = host.contextFor(UNDECLARED, runtime());
    expect(after.services.get(after.service("calendar:events"))).toBeUndefined();
    expect(host.ledger.refusals()).toEqual([{ kind: "service", pluginId: "notes", id: "calendar:events" }]);
    expect(reported.filter((line) => line.includes("calendar:events") && line.includes("services.consumes"))).toHaveLength(1);
  });

  it("still lists a revoked plugin's declared, registered ids", () => {
    const { host } = hostWith();
    host.provideService("clock", {});
    registered(host);
    const agenda = host.contextFor(DECLARING, runtime());
    host.release("agenda");
    expect([...agenda.services.ids()].sort()).toEqual(["calendar:events", "clock"]);
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
  const elsewhere: PluginManifest = { id: "t", name: "t", importName: "t", api: 2, targets: ["forebay"] };

  it("takes the app as the one application when absent", () => {
    expect(hostWith().host.supports(elsewhere)).not.toBeNull();
  });

  it("hosts every application when explicitly empty", () => {
    expect(hostWith({ applications: [] }).host.supports(elsewhere)).toBeNull();
  });
});

interface Screen {
  readonly provider: string;
}

function plugin(id: string, capabilities: { provides?: string[]; consumes?: string[] }, services?: PluginManifest["services"]): PluginManifest {
  return { id, name: id, importName: id, api: 2, capabilities, ...(services === undefined ? {} : { services }) };
}

function provideScreen(context: PluginContext, provider: string): Screen {
  const screen: Screen = { provider };
  context.provide(context.capability<Screen>("screens"), screen);
  return screen;
}

function watching(context: PluginContext): Array<[string, string]> {
  const heard: Array<[string, string]> = [];
  context.capabilities.watch(context.capability<Screen>("screens"), (screen, event) => heard.push([screen.provider, event]));
  return heard;
}

function providersOf(context: PluginContext): string[] {
  return context.capabilities.all(context.capability<Screen>("screens")).map((screen) => screen.provider);
}

const CALENDAR = plugin("calendar", { provides: ["screens"] });
const NOTES = plugin("notes", { provides: ["screens"] });
const AGENDA = plugin("agenda", { consumes: ["screens"] });
const OTHERS = plugin("others", {});

describe("consuming a capability", () => {
  it("answers an implementation only once its activation is verified", () => {
    const { host } = hostWith();
    const agenda = host.contextFor(AGENDA, runtime());
    const calendar = host.contextFor(CALENDAR, runtime());
    const screen = provideScreen(calendar, "calendar");
    expect(agenda.capabilities.all(agenda.capability<Screen>("screens"))).toEqual([]);
    expect(host.capability("screens")).toEqual([{ pluginId: "calendar", implementation: screen }]);
    expect(host.verifyActivation(CALENDAR)).toBeNull();
    expect(agenda.capabilities.all(agenda.capability<Screen>("screens"))[0]).toBe(screen);
  });

  it("answers in the order activations were verified, not the order they provided", () => {
    const { host } = hostWith();
    const agenda = host.contextFor(AGENDA, runtime());
    const calendar = host.contextFor(CALENDAR, runtime());
    const notes = host.contextFor(NOTES, runtime());
    provideScreen(calendar, "calendar");
    provideScreen(notes, "notes");
    host.verifyActivation(NOTES);
    host.verifyActivation(CALENDAR);
    expect(providersOf(agenda)).toEqual(["notes", "calendar"]);
  });

  it("never answers or announces a provider whose activation was refused", () => {
    const { host } = hostWith();
    const agenda = host.contextFor(AGENDA, runtime());
    const heard = watching(agenda);
    const greedy = plugin("calendar", { provides: ["screens", "tools"] });
    const calendar = host.contextFor(greedy, runtime());
    provideScreen(calendar, "calendar");
    const refusal = host.verifyActivation(greedy);
    expect(refusal).not.toBeNull();
    expect(refusal?.fix).toContain("capabilities.provides");
    host.markBroken("calendar", refusal!);
    expect(providersOf(agenda)).toEqual([]);
    expect(heard).toEqual([]);
  });

  it("tells a watcher once when a quarantined provider leaves, with the object it provided", () => {
    const { host } = hostWith();
    const agenda = host.contextFor(AGENDA, runtime());
    const objects: unknown[] = [];
    agenda.capabilities.watch(agenda.capability<Screen>("screens"), (screen) => objects.push(screen));
    const calendar = host.contextFor(CALENDAR, runtime());
    const screen = provideScreen(calendar, "calendar");
    host.verifyActivation(CALENDAR);
    host.markBroken("calendar", pluginError("calendar", "broke", "mend it"));
    host.release("calendar");
    expect(objects).toEqual([screen, screen]);
    expect(objects[1]).toBe(screen);
    expect(providersOf(agenda)).toEqual([]);
  });

  it("reports future changes only, never replaying what is already there", () => {
    const { host } = hostWith();
    const agenda = host.contextFor(AGENDA, runtime());
    const calendar = host.contextFor(CALENDAR, runtime());
    provideScreen(calendar, "calendar");
    host.verifyActivation(CALENDAR);
    const heard = watching(agenda);
    host.release("calendar");
    expect(heard).toEqual([["calendar", "withdraw"]]);
  });

  it("stops telling a watcher once its stop function is called", () => {
    const { host } = hostWith();
    const agenda = host.contextFor(AGENDA, runtime());
    const heard: string[] = [];
    const stop = agenda.capabilities.watch(agenda.capability<Screen>("screens"), (_screen, event) => heard.push(event));
    stop();
    const calendar = host.contextFor(CALENDAR, runtime());
    provideScreen(calendar, "calendar");
    host.verifyActivation(CALENDAR);
    expect(heard).toEqual([]);
  });

  it("refuses an undeclared all with an empty answer, and reports it once with the fix", () => {
    const { host, reported } = hostWith();
    const others = host.contextFor(OTHERS, runtime());
    const calendar = host.contextFor(CALENDAR, runtime());
    provideScreen(calendar, "calendar");
    host.verifyActivation(CALENDAR);
    expect(providersOf(others)).toEqual([]);
    expect(providersOf(others)).toEqual([]);
    expect(host.ledger.refusals()).toEqual([{ kind: "capability", pluginId: "others", id: "screens" }]);
    const lines = reported.filter((line) => line.includes("screens"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("capabilities.consumes");
  });

  it("keeps an undeclared watch inert, and reports it", () => {
    const { host } = hostWith();
    const others = host.contextFor(OTHERS, runtime());
    const heard = watching(others);
    const calendar = host.contextFor(CALENDAR, runtime());
    provideScreen(calendar, "calendar");
    host.verifyActivation(CALENDAR);
    expect(heard).toEqual([]);
    expect(host.ledger.refusals()).toEqual([{ kind: "capability", pluginId: "others", id: "screens" }]);
  });

  it("refuses an undeclared call from a released plugin as undeclared", () => {
    const { host } = hostWith();
    const others = host.contextFor(OTHERS, runtime());
    host.release("others");
    expect(providersOf(others)).toEqual([]);
    watching(others);
    expect(host.ledger.refusals()).toEqual([{ kind: "capability", pluginId: "others", id: "screens" }]);
  });

  it("lets a released plugin read all, and keeps its declared late watch inert and unrecorded", () => {
    const { host, reported } = hostWith();
    const agenda = host.contextFor(AGENDA, runtime());
    const calendar = host.contextFor(CALENDAR, runtime());
    provideScreen(calendar, "calendar");
    host.verifyActivation(CALENDAR);
    host.release("agenda");
    expect(providersOf(agenda)).toEqual(["calendar"]);
    const heard = watching(agenda);
    host.release("calendar");
    expect(heard).toEqual([]);
    expect(host.ledger.refusals()).toEqual([]);
    expect(reported.some((line) => line.includes("late watch") && line.includes("screens"))).toBe(true);
  });

  it("reports a watcher that throws, and the others still hear", () => {
    const { host, reported } = hostWith();
    const bad = host.contextFor(plugin("bad", { consumes: ["screens"] }), runtime());
    bad.capabilities.watch(bad.capability<Screen>("screens"), () => {
      throw new Error("boom");
    });
    const agenda = host.contextFor(AGENDA, runtime());
    const heard = watching(agenda);
    const calendar = host.contextFor(CALENDAR, runtime());
    provideScreen(calendar, "calendar");
    host.verifyActivation(CALENDAR);
    expect(heard).toEqual([["calendar", "provide"]]);
    expect(reported.some((line) => line.includes("boom") && line.includes("screens"))).toBe(true);
  });

  it("lets a plugin reach a capability it provides, and see its own implementation", () => {
    const { host } = hostWith();
    const calendar = host.contextFor(CALENDAR, runtime());
    provideScreen(calendar, "calendar");
    host.verifyActivation(CALENDAR);
    expect(providersOf(calendar)).toEqual(["calendar"]);
    expect(host.ledger.refusals()).toEqual([]);
  });

  it("tells a provider watching its own capability that it withdrew", () => {
    const { host } = hostWith();
    const calendar = host.contextFor(CALENDAR, runtime());
    const heard = watching(calendar);
    provideScreen(calendar, "calendar");
    host.verifyActivation(CALENDAR);
    host.release("calendar");
    expect(heard).toEqual([
      ["calendar", "provide"],
      ["calendar", "withdraw"],
    ]);
  });

  it("keeps a service refusal and a capability refusal that share an id apart", () => {
    const { host } = hostWith();
    const others = host.contextFor(OTHERS, runtime());
    others.services.get(others.service("screens"));
    providersOf(others);
    expect(host.ledger.refusals()).toEqual([
      { kind: "service", pluginId: "others", id: "screens" },
      { kind: "capability", pluginId: "others", id: "screens" },
    ]);
  });

  it("stops a released consumer hearing", () => {
    const { host } = hostWith();
    const agenda = host.contextFor(AGENDA, runtime());
    const heard = watching(agenda);
    host.release("agenda");
    const calendar = host.contextFor(CALENDAR, runtime());
    provideScreen(calendar, "calendar");
    host.verifyActivation(CALENDAR);
    expect(heard).toEqual([]);
  });

  it("stops a quarantined consumer hearing", () => {
    const { host } = hostWith();
    const agenda = host.contextFor(AGENDA, runtime());
    const heard = watching(agenda);
    host.markBroken("agenda", pluginError("agenda", "broke", "mend it"));
    const calendar = host.contextFor(CALENDAR, runtime());
    provideScreen(calendar, "calendar");
    host.verifyActivation(CALENDAR);
    expect(heard).toEqual([]);
  });
});
