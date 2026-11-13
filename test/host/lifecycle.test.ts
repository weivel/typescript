import koffi from "koffi";
import { afterEach, describe, expect, it } from "vitest";
import { RefusalCode } from "../../src/core/index.ts";
import { RefusalError, type PluginContext } from "../../src/context/index.ts";
import { hostDestroyed, type Plugin } from "../../src/host/index.ts";
import { FunctionKind, type LibraryDeclaration } from "../../src/standard/index.ts";
import { alive, createHostWorld, echoLibraryPath, settle, type HostWorld } from "./world.ts";

/** What the plugins of one test did, in the order they did it. */
type Trace = string[];

interface Sunk {
  readonly errors: unknown[];
}

/** A host whose error sink records what reaches it. */
function sinkingWorld(): HostWorld & Sunk {
  const errors: unknown[] = [];
  return { ...createHostWorld({}, { onListenerError: (error) => void errors.push(error) }), errors };
}

/** Registers a plugin built as a value and answers its handle. */
function registered(world: HostWorld, importName: string, entry: Plugin, manifest: Record<string, unknown> = {}): bigint {
  return alive(world.host.register({ importName, api: 1, ...manifest }, entry)).plugin!;
}

/** An entry whose activate records itself, keeps its context, and then runs `body`. */
function recordingEntry(trace: Trace, name: string, contexts: Map<string, PluginContext>, body: (context: PluginContext) => unknown = () => undefined): Plugin {
  return {
    activate(context) {
      trace.push(`activate ${name}`);
      contexts.set(name, context);
      return body(context) as void | Promise<void>;
    },
    deactivate() {
      trace.push(`deactivate ${name}`);
    },
  };
}

/** Records how a want of `id` ended, on the trace. */
function followWant(trace: Trace, name: string, context: PluginContext, id: string): Promise<unknown> {
  return context.services.want(context.service(id)).then(
    () => void trace.push(`settled ${name} ${id}`),
    (error: unknown) => {
      trace.push(`rejected ${name} ${id} ${error instanceof RefusalError ? error.code : String(error)}`);
      throw error;
    },
  );
}

describe("activation", () => {
  it("answers the plan once every activate has started, before any has settled", () => {
    const world = createHostWorld();
    const trace: Trace = [];
    const contexts = new Map<string, PluginContext>();
    const never = new Promise<void>(() => undefined);
    const first = registered(world, "first", recordingEntry(trace, "first", contexts, () => never));
    const second = registered(world, "second", recordingEntry(trace, "second", contexts, () => never));

    const started = alive(world.host.activate([first, second]));

    expect(started.plan.order).toEqual([first, second]);
    expect(trace).toEqual(["activate first", "activate second"]);
  });

  it("answers a plugin released while its activate runs as released, and its activate settling later does nothing", async () => {
    const world = sinkingWorld();
    const trace: Trace = [];
    const contexts = new Map<string, PluginContext>();
    let finish: () => void = () => undefined;
    const slow = registered(world, "slow", recordingEntry(trace, "slow", contexts, () => new Promise<void>((resolve) => (finish = resolve))));
    const started = alive(world.host.activate([slow]));

    await world.host.release(slow);
    finish();
    const outcomes = await started.outcomes;
    await settle();

    expect(outcomes.map((outcome) => outcome.state)).toEqual(["released"]);
    expect(trace).toEqual(["activate slow", "deactivate slow"]);
    expect(world.host.plugin(slow)).toBeUndefined();
    expect(world.host.core.ledger().value!.rows).toEqual([]);
    expect(world.errors).toEqual([]);
    expect(world.hostLog.entries.filter((entry) => entry.level === "error")).toEqual([]);
  });

  it("answers an open that fails after the core opened the plugin as failed, to the sink, releases and forgets it at once, and starts the rest", async () => {
    const world = sinkingWorld();
    const trace: Trace = [];
    const contexts = new Map<string, PluginContext>();
    const failure = new Error("context failed");
    const broken = registered(world, "broken", recordingEntry(trace, "broken", contexts));
    const sound = registered(world, "sound", recordingEntry(trace, "sound", contexts));
    const create = world.host.contexts.create.bind(world.host.contexts);
    world.host.contexts.create = (plugin, ...rest) => {
      if (plugin === broken) {
        throw failure;
      }
      return create(plugin, ...rest);
    };

    const started = alive(world.host.activate([broken, sound]));
    const outcomes = await started.outcomes;

    expect(started.plan.order).toEqual([broken, sound]);
    expect(outcomes.map((outcome) => [outcome.importName, outcome.state, outcome.refusal])).toEqual([
      ["broken", "failed", undefined],
      ["sound", "active", undefined],
    ]);
    expect(trace).toEqual(["activate sound"]);
    expect(world.errors).toEqual([failure]);
    expect(world.host.destroyed).toBe(false);
    expect(world.host.core.ledger().value!.rows.map((row) => row.importName)).toEqual(["sound"]);
    expect(world.host.core.ledgerEntry(broken).value).toBeUndefined();
    expect(world.host.plugin(broken)).toBeUndefined();
  });

  it("answers an open that fails before the core opened the plugin as failed, to the sink, releasing nothing", async () => {
    const world = sinkingWorld();
    const trace: Trace = [];
    const contexts = new Map<string, PluginContext>();
    const failure = new Error("open failed");
    const broken = registered(world, "broken", recordingEntry(trace, "broken", contexts));
    const sound = registered(world, "sound", recordingEntry(trace, "sound", contexts));
    const openPlugin = world.host.core.openPlugin.bind(world.host.core);
    world.host.core.openPlugin = (plugin, ...rest) => {
      if (plugin === broken) {
        throw failure;
      }
      return openPlugin(plugin, ...rest);
    };
    const releasePlugin = world.host.core.releasePlugin.bind(world.host.core);
    const releasedInCore: bigint[] = [];
    world.host.core.releasePlugin = (plugin) => {
      releasedInCore.push(plugin);
      return releasePlugin(plugin);
    };

    const outcomes = await alive(world.host.activate([broken, sound])).outcomes;

    expect(outcomes.map((outcome) => [outcome.importName, outcome.state, outcome.refusal])).toEqual([
      ["broken", "failed", undefined],
      ["sound", "active", undefined],
    ]);
    expect(trace).toEqual(["activate sound"]);
    expect(world.errors).toEqual([failure]);
    expect(releasedInCore).toEqual([]);
    expect(world.host.plugin(broken)?.manifest.importName).toBe("broken");
  });
});

describe("release", () => {
  it("reports a deactivate that throws to the error sink and releases the plugin all the same", async () => {
    const world = sinkingWorld();
    const failure = new Error("deactivate failed");
    const plugin = registered(world, "clumsy", {
      activate() {},
      deactivate() {
        throw failure;
      },
    });
    await alive(world.host.activate([plugin])).outcomes;

    await expect(world.host.release(plugin)).resolves.toBeUndefined();

    expect(world.errors).toEqual([failure]);
    expect(world.host.plugin(plugin)).toBeUndefined();
  });

  it("settles a release whose forget throws, the throw reported to the error sink", async () => {
    const world = sinkingWorld();
    const failure = new Error("forget failed");
    const plugin = registered(world, "forgetful", { activate() {} });
    await alive(world.host.activate([plugin])).outcomes;
    world.host.contexts.forget = () => {
      throw failure;
    };
    let releaseSettled = false;

    void world.host.release(plugin).then(() => (releaseSettled = true));
    await settle();

    expect(releaseSettled).toBe(true);
    expect(world.errors).toEqual([failure]);
  });

  it("made inside a dispatch, lets the events of its release reach the plugin before its entries end", async () => {
    const world = sinkingWorld();
    const trace: Trace = [];
    const contexts = new Map<string, PluginContext>();
    const releases: Promise<unknown>[] = [];
    const provider = registered(
      world,
      "provider",
      recordingEntry(trace, "provider", contexts, (context) => context.provide(context.capability("screens"), {})),
      { entry: "provider.ts", capabilities: { provides: ["screens"] } },
    );
    const watcher = registered(
      world,
      "watcher",
      recordingEntry(trace, "watcher", contexts, (context) => {
        context.capabilities.watch(context.capability("screens"), (_implementation, change) => {
          trace.push(`watcher heard ${change}`);
          if (change === "withdraw") {
            releases.push(world.host.release(watcher));
          }
        });
        void followWant(trace, "watcher", context, "nobody:thing").catch(() => undefined);
      }),
      { capabilities: { consumes: ["screens"] }, services: { consumes: [{ id: "nobody:thing" }] } },
    );
    await alive(world.host.activate([provider, watcher])).outcomes;

    await world.host.release(provider);
    await Promise.all(releases);
    await settle();

    expect(releases).toHaveLength(1);
    expect(trace).toContain(`rejected watcher nobody:thing ${RefusalCode.Stopped}`);
    expect(trace.indexOf("deactivate watcher")).toBeLessThan(trace.indexOf(`rejected watcher nobody:thing ${RefusalCode.Stopped}`));
    expect(world.host.contexts.tracked(watcher)).toBe(0);
    expect(world.host.plugin(watcher)).toBeUndefined();
    expect(world.errors).toEqual([]);
  });
});

describe("destroy", () => {
  it("releases every opened plugin, the last opened first, an in-flight and a quarantined one included", async () => {
    const world = sinkingWorld();
    const trace: Trace = [];
    const contexts = new Map<string, PluginContext>();
    const steady = registered(world, "steady", recordingEntry(trace, "steady", contexts));
    const broken = registered(
      world,
      "broken",
      recordingEntry(trace, "broken", contexts, () => {
        throw new Error("no disk");
      }),
    );
    const waiting = registered(
      world,
      "waiting",
      recordingEntry(trace, "waiting", contexts, (context) => followWant(trace, "waiting", context, "nobody:thing")),
      { services: { consumes: [{ id: "nobody:thing" }] } },
    );
    const started = alive(world.host.activate([steady, broken, waiting]));
    await settle();

    await world.host.destroy();
    const outcomes = await started.outcomes;
    await settle();

    expect(outcomes.map((outcome) => [outcome.importName, outcome.state])).toEqual([
      ["steady", "active"],
      ["broken", "quarantined"],
      ["waiting", "released"],
    ]);
    expect(trace.filter((record) => record.startsWith("deactivate"))).toEqual(["deactivate waiting", "deactivate broken", "deactivate steady"]);
    expect(trace.indexOf(`rejected waiting nobody:thing ${RefusalCode.Stopped}`)).toBeGreaterThan(trace.indexOf("deactivate waiting"));
    expect(world.host.core.destroyed).toBe(true);
    expect(world.errors).toEqual([]);
  });

  it("answers every later call quietly that the host is destroyed, and a second destroy with the first one's promise", async () => {
    const world = sinkingWorld();
    const plugin = registered(world, "late", { activate() {} });
    const destroyed = world.host.destroy();
    await destroyed;
    const logged = world.hostLog.entries.length;

    const answers = [
      world.host.verify(plugin),
      world.host.register({ importName: "later", api: 1 }, { activate() {} }),
      world.host.activate([plugin]),
      world.host.open(plugin),
      await world.host.release(plugin),
      world.host.registerHostService({ id: "clock" }, {}),
      world.host.loadLibrary({ importName: "echo", version: "0.1.0", release: "echo_release", services: [] }, echoLibraryPath),
    ];

    expect(answers.every((answer) => answer === hostDestroyed)).toBe(true);
    expect(world.host.destroy()).toBe(destroyed);
    expect(world.hostLog.entries.length).toBe(logged);
    expect(world.errors).toEqual([]);
  });

  it("made inside a dispatch, waits behind the events already queued before it releases anything", async () => {
    const world = sinkingWorld();
    const trace: Trace = [];
    const contexts = new Map<string, PluginContext>();
    const destructions: Promise<void>[] = [];
    const provider = registered(
      world,
      "provider",
      recordingEntry(trace, "provider", contexts, (context) => {
        context.provide(context.capability("screens"), {});
        context.services.register(context.service("provider:thing"), {});
      }),
      { entry: "provider.ts", capabilities: { provides: ["screens"] }, services: { provides: [{ id: "provider:thing" }] } },
    );
    const watcher = registered(
      world,
      "watcher",
      recordingEntry(trace, "watcher", contexts, (context) => {
        context.capabilities.watch(context.capability("screens"), (_implementation, change) => {
          trace.push(`watcher heard ${change}`);
          if (change === "withdraw") {
            destructions.push(world.host.destroy());
          }
        });
        context.services.watch(context.service("provider:thing"), (_service, change) => void trace.push(`watcher heard ${change}`));
      }),
      { capabilities: { consumes: ["screens"] }, services: { consumes: [{ id: "provider:thing" }] } },
    );
    await alive(world.host.activate([provider, watcher])).outcomes;

    await world.host.release(provider);
    await Promise.all(destructions);

    expect(trace.slice(trace.indexOf("deactivate provider"))).toEqual([
      "deactivate provider",
      "watcher heard withdraw",
      "watcher heard unregister",
      "deactivate watcher",
    ]);
    expect(world.host.core.destroyed).toBe(true);
    expect(world.errors).toEqual([]);
  });

  it("destroys the core whatever a release did, the failure reported to the error sink", async () => {
    const world = sinkingWorld();
    const failure = new Error("release failed");
    const plugin = registered(world, "stubborn", { activate() {} });
    await alive(world.host.activate([plugin])).outcomes;
    world.host.core.releasePlugin = () => {
      throw failure;
    };

    await expect(world.host.destroy()).resolves.toBeUndefined();

    expect(world.errors).toEqual([failure]);
    expect(world.host.core.destroyed).toBe(true);
  });

  it("reports an unload that throws to the error sink, unloads the rest and still destroys the core", async () => {
    const world = sinkingWorld();
    const failure = new Error("unload failed");
    const declaration: LibraryDeclaration = {
      importName: "echo",
      version: "0.1.0",
      release: "echo_release",
      services: [{ id: "echo", functions: [{ name: "echo", symbol: "echo_echo", kind: FunctionKind.Bytes, context: 0 }] }],
    };
    const load = koffi.load;
    koffi.load = ((path: string, ...rest: unknown[]) => {
      const library = (load as (...parameters: unknown[]) => koffi.IKoffiLib)(path, ...rest);
      return Object.assign(Object.create(library) as koffi.IKoffiLib, {
        func: library.func.bind(library),
        unload: () => {
          library.unload();
          throw failure;
        },
      });
    }) as typeof koffi.load;
    let throwing;
    try {
      throwing = alive(world.host.loadLibrary(declaration, echoLibraryPath));
    } finally {
      koffi.load = load;
    }
    const plain = alive(world.host.loadLibrary({ ...declaration, services: [{ ...declaration.services[0]!, id: "echo-again" }] }, echoLibraryPath));

    await world.host.destroy();

    expect(world.errors).toEqual([failure]);
    expect(() => plain.services.get("echo-again")!.echo!(new Uint8Array([1]))).toThrow(/unloaded/);
    expect(() => throwing.services.get("echo")!.echo!(new Uint8Array([1]))).toThrow(/unloaded/);
    expect(world.host.core.destroyed).toBe(true);
  });
});

afterEach(async () => {
  await settle();
});
