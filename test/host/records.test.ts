import koffi from "koffi";
import { afterEach, describe, expect, it } from "vitest";
import { coreStructs, EventKind, HOST, loadCoreLibrary, offsetOf, RefusalCode, Status, type CoreFunctions } from "../../src/core/index.ts";
import { RefusalError, type PluginContext } from "../../src/context/index.ts";
import type { Plugin } from "../../src/host/index.ts";
import { coreLibraryPath } from "../real-core.ts";
import { recordingLogger } from "../context/world.ts";
import { alive, createHostWorld, settle, type HostWorld } from "./world.ts";

const functions = loadCoreLibrary(coreLibraryPath).functions;
const originals = { ...functions };

afterEach(() => {
  Object.assign(functions, originals);
});

/** Replaces one function of the core every host in this process calls, until the test ends. */
function wrap(name: keyof CoreFunctions, replacement: (...parameters: unknown[]) => number): void {
  functions[name] = replacement;
}

/** Rewrites the event the core hands out next into a refusal of reach naming `plugin`, with no texts. */
function rewriteNextEventIntoReachRefusal(plugin: () => bigint | undefined): void {
  wrap("weivel_next_event", (...parameters) => {
    const status = originals.weivel_next_event(...parameters);
    const named = plugin();
    if (status === Status.Ok && named !== undefined) {
      const eventBuffer = parameters[1] as object;
      koffi.encode(eventBuffer, offsetOf("weivel_event", "kind"), "uint32_t", EventKind.ReachRefused);
      koffi.encode(eventBuffer, offsetOf("weivel_event", "data"), coreStructs.weivel_reach_refusal, {
        kind: 1,
        plugin: named,
        id: null,
        refusal: { code: RefusalCode.Undeclared, detail: null, fix: null },
        subject: null,
        has_fix: 0,
      });
    }
    return status;
  });
}

function addPending(pending: unknown, count: number): void {
  if (pending instanceof Uint32Array) {
    pending[0] = pending[0]! + count;
  }
}

describe("the host's record of a plugin", () => {
  it("is made before any event its registration queued is dispatched", () => {
    let registered: bigint | undefined;
    let rewrite: bigint | undefined;
    wrap("weivel_register_manifest", (...parameters) => {
      const status = originals.weivel_register_manifest(...parameters);
      registered = BigInt((parameters[2] as unknown[])[0] as number | bigint);
      const extra = new Uint32Array(1);
      originals.weivel_register_service(parameters[0], HOST, "", [0], extra);
      addPending(parameters[3], extra[0]!);
      rewrite = registered;
      return status;
    });
    rewriteNextEventIntoReachRefusal(() => {
      const named = rewrite;
      rewrite = undefined;
      return named;
    });
    const world = createHostWorld();

    alive(world.host.register({ importName: "alpha", api: 1 }, { activate() {} }));

    expect(world.hostLog.entries.filter((entry) => entry.level === "warn").map((entry) => entry.message)).toEqual([
      expect.stringMatching(/^alpha was refused/),
    ]);
  });
});

describe("a plugin's context", () => {
  it("is built no later than the open, so the open's own events reach a plugin whose context exists", async () => {
    const order: string[] = [];
    wrap("weivel_open_plugin", (...parameters) => {
      const status = originals.weivel_open_plugin(...parameters);
      const extra = new Uint32Array(1);
      originals.weivel_get_service(parameters[0], parameters[1], "nobody:thing", [0], extra);
      addPending(parameters[3], extra[0]!);
      return status;
    });
    const hostLog = recordingLogger();
    const world = createHostWorld(
      {},
      {
        log: { ...hostLog.logger, warn: (message) => order.push(`warn ${message.split(" ")[0]}`) },
        pluginLog: (manifest) => {
          order.push(`context ${manifest.importName}`);
          return recordingLogger().logger;
        },
      },
    );
    const plugin = alive(world.host.register({ importName: "alpha", api: 1 }, { activate() {} })).plugin!;

    await alive(world.host.activate([plugin])).outcomes;

    expect(order).toEqual(["context alpha", "warn alpha"]);
  });
});

/** Records how a promise ended, without waiting for it. */
function track(promise: Promise<unknown>) {
  const outcome: { reason?: unknown; settled: boolean } = { settled: false };
  promise.then(
    () => Object.assign(outcome, { settled: true }),
    (reason: unknown) => Object.assign(outcome, { reason, settled: true }),
  );
  return outcome;
}

function registered(world: HostWorld, importName: string, entry: Plugin, manifest: Record<string, unknown> = {}): bigint {
  return alive(world.host.register({ importName, api: 1, ...manifest }, entry)).plugin!;
}

describe("a want made after its plugin's release, inside a dispatch", () => {
  it("still settles to the plugin, rejected stopped, though its forget ran before the settlement was dispatched", async () => {
    const world = createHostWorld();
    const releases: Promise<unknown>[] = [];
    let late: ReturnType<typeof track> | undefined;
    const provider = registered(world, "provider", { activate: (context) => context.provide(context.capability("screens"), {}) }, {
      capabilities: { provides: ["screens"] },
    });
    const watcher = registered(
      world,
      "watcher",
      {
        activate(context: PluginContext) {
          context.capabilities.watch(context.capability("screens"), (_implementation, change) => {
            if (change === "withdraw") {
              releases.push(world.host.release(watcher));
              late = track(context.services.want(context.service("nobody:thing")));
            }
          });
        },
      },
      { capabilities: { consumes: ["screens"] }, services: { consumes: [{ id: "nobody:thing" }] } },
    );
    await alive(world.host.activate([provider, watcher])).outcomes;

    await world.host.release(provider);
    await Promise.all(releases);
    await settle();

    expect(late?.settled).toBe(true);
    expect(late?.reason).toBeInstanceOf(RefusalError);
    expect((late?.reason as RefusalError).code).toBe(RefusalCode.Stopped);
  });
});
