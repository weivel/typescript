import koffi from "koffi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOST, PluginStatus, type CoreEvent, type Manifest } from "../../src/core/index.ts";
import { DetachedError, RefusalError, type PluginContext } from "../../src/context/index.ts";
import { hostDestroyed, type ActivationOutcome, type Plugin } from "../../src/host/index.ts";
import { FunctionKind, type LibraryDeclaration } from "../../src/standard/index.ts";
import { alive, createHostWorld, echoLibraryPath, ManualScheduler, settle, type HostWorld } from "./world.ts";

interface Sunk {
  readonly errors: unknown[];
}

function sinkingWorld(): HostWorld & Sunk {
  const errors: unknown[] = [];
  return { ...createHostWorld({}, { onListenerError: (error) => void errors.push(error) }), errors };
}

function registered(world: HostWorld, importName: string, entry: Plugin, manifest: Record<string, unknown> = {}): bigint {
  return alive(world.host.register({ importName, api: 1, ...manifest } as Manifest, entry)).plugin!;
}

/** A promise and the function that resolves it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((settle) => (resolve = settle));
  return { promise, resolve };
}

/** Calls `hear` with every event the host's contexts receive, before they do. */
function overhear(world: HostWorld, hear: (event: CoreEvent) => void): void {
  const receive = world.host.contexts.receive;
  Object.assign(world.host.contexts, {
    receive: (event: CoreEvent) => {
      hear(event);
      receive(event);
    },
  });
}

describe("registration", () => {
  it("copies the manifest whole, so the caller may change its own once registration returns", async () => {
    const world = createHostWorld();
    const manifest = { importName: "alpha", api: 1, services: { consumes: [{ id: "nobody:thing" }] } };
    let seen: Manifest | undefined;
    const plugin = alive(world.host.register(manifest as Manifest, { activate: (context) => void (seen = context.manifest) })).plugin!;

    manifest.importName = "changed";
    manifest.services.consumes.push({ id: "other:thing" });
    await alive(world.host.activate([plugin])).outcomes;

    const kept = world.host.plugin(plugin)!.manifest;
    expect(kept).not.toBe(manifest);
    expect(kept.importName).toBe("alpha");
    expect(kept.services?.consumes).toEqual([{ id: "nobody:thing" }]);
    expect(seen).toBe(kept);
  });
});

describe("a verification the core refuses", () => {
  it("quarantines the plugin before any event of the verification is dispatched", async () => {
    const world = createHostWorld();
    const plugin = registered(world, "flaky", { activate() {} }, { capabilities: { provides: ["extras"] } });
    const statusesHeard: (number | undefined)[] = [];
    let verifying = false;
    overhear(world, (event) => {
      if (verifying && event.kind === "refusal") {
        statusesHeard.push(world.host.core.ledgerEntry(plugin).value?.status);
      }
    });
    const started = alive(world.host.activate([plugin]));
    verifying = true;

    const [outcome] = await started.outcomes;

    expect(outcome!.state).toBe("quarantined");
    expect(statusesHeard.length).toBeGreaterThan(0);
    expect(statusesHeard.every((status) => status === PluginStatus.Quarantined)).toBe(true);
  });
});

let undeclaredIds = 0;

/**
 * Whether a refusal of reach reaches the context's event listeners, by getting an id its manifest never declared.
 *
 * @implNote The core reports a refusal of reach once per plugin and id, so each probe asks for a new id.
 */
function hearsItsEvents(context: PluginContext): boolean {
  const heard: string[] = [];
  const stop = context.events.listen((event) => void heard.push(event.kind));
  undeclaredIds += 1;
  try {
    context.services.get(context.service(`undeclared:id${undeclaredIds}`));
  } catch {
    // the refusal is also answered to the caller; only what the listener heard counts here
  }
  stop();
  return heard.includes("reach-refused");
}

describe("a plugin the host holds open", () => {
  it("opened again is answered with the core's refusal, its context left whole and still the one detached", async () => {
    const world = sinkingWorld();
    const plugin = registered(world, "alpha", { activate() {} }, { services: { provides: [{ id: "alpha:thing" }] } });
    const context = alive(world.host.open(plugin));
    context.services.register(context.service("alpha:thing"), {});
    const tracked = world.host.contexts.tracked(plugin);

    expect(() => world.host.open(plugin)).toThrow(RefusalError);

    expect(world.host.contexts.tracked(plugin)).toBe(tracked);
    expect(hearsItsEvents(context)).toBe(true);
    await world.host.release(plugin);
    expect(() => context.services.ids()).toThrow(DetachedError);
    expect(world.errors).toEqual([]);
  });

  it("activated again, or while its activate is in flight, is answered refused, its context left whole", async () => {
    const world = sinkingWorld();
    const contexts: PluginContext[] = [];
    const pending = deferred();
    const plugin = registered(
      world,
      "alpha",
      {
        activate(context) {
          contexts.push(context);
          return pending.promise;
        },
      },
      { services: { provides: [{ id: "alpha:thing" }] } },
    );
    const first = alive(world.host.activate([plugin]));
    contexts[0]!.services.register(contexts[0]!.service("alpha:thing"), {});
    const tracked = world.host.contexts.tracked(plugin);

    const [whileInFlight] = await alive(world.host.activate([plugin])).outcomes;
    pending.resolve();
    await first.outcomes;
    const [whileActive] = await alive(world.host.activate([plugin])).outcomes;

    expect([whileInFlight!.state, whileActive!.state]).toEqual(["refused", "refused"]);
    expect(contexts).toHaveLength(1);
    expect(world.host.contexts.tracked(plugin)).toBe(tracked);
    expect(hearsItsEvents(contexts[0]!)).toBe(true);
    await world.host.release(plugin);
    expect(() => contexts[0]!.services.ids()).toThrow(DetachedError);
  });

  it("quarantined and activated again keeps its context", async () => {
    const world = sinkingWorld();
    const contexts: PluginContext[] = [];
    const plugin = registered(world, "alpha", {
      activate(context) {
        contexts.push(context);
        if (contexts.length === 1) {
          throw new Error("not yet");
        }
      },
    });

    const [quarantined] = await alive(world.host.activate([plugin])).outcomes;
    const [reopened] = await alive(world.host.activate([plugin])).outcomes;

    expect([quarantined!.state, reopened!.state]).toEqual(["quarantined", "active"]);
    expect(contexts[1]).toBe(contexts[0]);
    expect(hearsItsEvents(contexts[0]!)).toBe(true);
    await world.host.release(plugin);
    expect(() => contexts[0]!.services.ids()).toThrow(DetachedError);
  });
});

describe("a release", () => {
  it("of a plugin registered and never opened answers that there was nothing to release, and does nothing", async () => {
    const world = sinkingWorld();
    const plugin = registered(world, "idle", { activate() {} });

    await expect(world.host.release(plugin)).resolves.toBe(false);

    expect(world.host.core.ledgerEntry(plugin).value?.status).toBe(PluginStatus.Registered);
    expect(world.host.plugin(plugin)).toBeDefined();
    const [outcome] = await alive(world.host.activate([plugin])).outcomes;
    expect(outcome!.state).toBe("active");
    await expect(world.host.release(plugin)).resolves.toBe(true);
    await expect(world.host.release(plugin)).resolves.toBe(false);
  });
});

describe("a verification the caller asks for", () => {
  it("of a plugin the host never opened is answered as the core answers it, quarantining nothing", () => {
    const world = createHostWorld();
    const plugin = registered(world, "idle", { activate() {} });

    const answer = alive(world.host.verify(plugin)) as ActivationOutcome;

    expect(answer.state).toBe("refused");
    expect(answer.refusal).toBeDefined();
    expect(world.host.core.ledgerEntry(plugin).value?.status).toBe(PluginStatus.Registered);
  });

  it("of a handle the host never registered is answered as the core answers it, never thrown", () => {
    const world = createHostWorld();

    const answer = alive(world.host.verify(123n)) as ActivationOutcome;

    expect(answer.plugin).toBe(123n);
    expect(answer.state).toBe("refused");
    expect(answer.importName).toBeUndefined();
  });
});

describe("destroy", () => {
  it("destroys the core and never rejects when the scheduler's cancel throws, the throw reported to the sink", async () => {
    const errors: unknown[] = [];
    const cancelFailure = new Error("cancel failed");
    const scheduler = new ManualScheduler();
    scheduler.cancel = () => {
      throw cancelFailure;
    };
    const world = createHostWorld({}, { scheduler, onListenerError: (error) => void errors.push(error) });
    const plugin = registered(world, "waiter", { activate: (context) => void context.services.want(context.service("nobody:thing"), { timeoutMillis: 1000 }).catch(() => undefined) }, {
      services: { consumes: [{ id: "nobody:thing" }] },
    });
    await alive(world.host.activate([plugin])).outcomes;
    expect(scheduler.armed.size).toBe(1);

    await expect(world.host.destroy()).resolves.toBeUndefined();

    expect(world.host.core.destroyed).toBe(true);
    expect(errors).toContain(cancelFailure);
  });

  it("made inside an activate, starts no later plugin of the plan, answering it released", async () => {
    const world = sinkingWorld();
    const activated: string[] = [];
    const first = registered(world, "first", {
      activate() {
        activated.push("first");
        void world.host.destroy();
      },
    });
    const second = registered(world, "second", { activate: () => void activated.push("second") });

    const outcomes = await alive(world.host.activate([first, second])).outcomes;
    await world.host.destroy();

    expect(activated).toEqual(["first"]);
    expect([...world.pluginLogs.keys()]).toEqual(["first"]);
    expect(outcomes.map((outcome) => [outcome.importName, outcome.state])).toEqual([
      ["first", "released"],
      ["second", "released"],
    ]);
    expect(world.errors).toEqual([]);
  });

  it("is quiet from the moment it is called, even while it waits behind a dispatch", async () => {
    const world = sinkingWorld();
    const answers: unknown[] = [];
    const contexts = new Map<string, PluginContext>();
    const provider = registered(world, "provider", { activate: (context) => context.provide(context.capability("screens"), {}) }, {
      capabilities: { provides: ["screens"] },
    });
    const watcher = registered(
      world,
      "watcher",
      {
        activate(context) {
          contexts.set("watcher", context);
          context.capabilities.watch(context.capability("screens"), (_implementation, change) => {
            if (change === "provide") {
              void world.host.destroy();
              answers.push(world.host.verify(provider), world.host.register({ importName: "later", api: 1 }, { activate() {} }));
            }
          });
        },
      },
      { capabilities: { consumes: ["screens"] } },
    );

    await alive(world.host.activate([watcher, provider])).outcomes;
    await world.host.destroy();

    expect(answers).toEqual([hostDestroyed, hostDestroyed]);
    expect(world.errors).toEqual([]);
  });

  it("waits for a release already under way, its deactivate still pending", async () => {
    const world = sinkingWorld();
    const deactivating = deferred();
    const plugin = registered(world, "slow", { activate() {}, deactivate: () => deactivating.promise });
    await alive(world.host.activate([plugin])).outcomes;
    const released = world.host.release(plugin);
    let destroyed = false;

    const destruction = world.host.destroy().then(() => (destroyed = true));
    await settle();
    const destroyedBeforeTheDeactivate = destroyed;
    deactivating.resolve();
    await destruction;
    await released;

    expect(destroyedBeforeTheDeactivate).toBe(false);
    expect(world.host.core.destroyed).toBe(true);
    expect(world.errors).toEqual([]);
  });
});

const echoDeclaration = (ids: readonly string[]): LibraryDeclaration => ({
  importName: "echo",
  version: "0.1.0",
  release: "echo_release",
  services: ids.map((id) => ({ id, functions: [{ name: "echo", symbol: "echo_echo", kind: FunctionKind.Bytes, context: 0 }] })),
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface LibraryCounts {
  unloads: number;
  releases: number;
}

/** Counts, until the test ends, every unload of a library koffi loads and every call of the echo library's release. */
function countLibraryCalls(): LibraryCounts {
  const counts: LibraryCounts = { unloads: 0, releases: 0 };
  const load = koffi.load.bind(koffi);
  vi.spyOn(koffi, "load").mockImplementation((path: string | null) => {
    const library = load(path);
    const unload = library.unload.bind(library);
    const bind = library.func.bind(library) as (...parameters: unknown[]) => (...arguments_: unknown[]) => unknown;
    library.unload = () => {
      counts.unloads += 1;
      unload();
    };
    library.func = ((...parameters: unknown[]) => {
      const bound = bind(...parameters);
      return parameters[0] === "echo_release"
        ? (...arguments_: unknown[]) => {
            counts.releases += 1;
            return bound(...arguments_);
          }
        : bound;
    }) as typeof library.func;
    return library;
  });
  return counts;
}

describe("loading a C library", () => {
  it("undoes a load that fails partway as an unload, what it registered unregistered and its binary closed", () => {
    const world = sinkingWorld();
    const counts = countLibraryCalls();

    expect(() => world.host.loadLibrary(echoDeclaration(["echo", ""]), echoLibraryPath)).toThrow();

    expect(world.host.core.getService(HOST, "echo").value).toBeUndefined();
    expect(counts.unloads).toBe(1);
    expect(() => world.host.registerHostService({ id: "echo" }, {})).not.toThrow();
  });

  it("refuses a declaration that lists an id twice, registering nothing and telling no sink", () => {
    const world = sinkingWorld();

    expect(() => world.host.loadLibrary(echoDeclaration(["echo", "echo"]), echoLibraryPath)).toThrow(/echo/);
    expect(world.host.core.getService(0xffff_ffff_ffff_ffffn, "echo").value).toBeUndefined();
    expect(world.errors).toEqual([]);
  });

  it("refuses an id already registered under the host, by the host itself or another live library", () => {
    const world = sinkingWorld();
    alive(world.host.registerHostService({ id: "echo" }, {}));
    alive(world.host.loadLibrary(echoDeclaration(["other"]), echoLibraryPath));

    expect(() => world.host.loadLibrary(echoDeclaration(["echo"]), echoLibraryPath)).toThrow(/echo/);
    expect(() => world.host.loadLibrary(echoDeclaration(["other"]), echoLibraryPath)).toThrow(/other/);
    expect(world.errors).toEqual([]);
  });

  it("refuses an id a plugin has registered", async () => {
    const world = sinkingWorld();
    const plugin = registered(world, "echo", { activate: (context) => void context.services.register(context.service("echo:thing"), {}) }, {
      services: { provides: [{ id: "echo:thing" }] },
    });
    await alive(world.host.activate([plugin])).outcomes;

    expect(() => world.host.loadLibrary(echoDeclaration(["echo:thing"]), echoLibraryPath)).toThrow(/echo:thing/);
  });

  it("makes the host's own registration of an id a live library declares refused", () => {
    const world = sinkingWorld();
    alive(world.host.loadLibrary(echoDeclaration(["echo"]), echoLibraryPath));

    expect(() => world.host.registerHostService({ id: "echo" }, {})).toThrow(/echo/);
    expect(world.errors).toEqual([]);
  });
});
