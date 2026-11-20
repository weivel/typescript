import { readFileSync } from "node:fs";
import { createServer, connect, type AddressInfo } from "node:net";
import { join } from "node:path";
import koffi from "koffi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blockingOperationsOf, LibraryUnloadedError, type BoundDefinition, type LoadedLibrary } from "../../src/host/index.ts";
import type { LibraryDeclaration } from "../../src/standard/index.ts";
import { realStandard } from "../real-standard.ts";
import { alive, createHostWorld, describedLibraryPath, plugin, pluginDirectory, registerDirectory, type HostWorld } from "./world.ts";

const fixtureDirectory = join(import.meta.dirname, "..", "..", "siblings", "standard", "test", "described");
const mirrorId = "described-mirror";
const walkerId = "described-walker";

afterEach(() => {
  vi.restoreAllMocks();
});

function declaration(): LibraryDeclaration {
  const read = realStandard().readLibrary(readFileSync(join(fixtureDirectory, "library.json"), "utf8"));
  if (read.value === undefined) {
    throw new Error(`the standard refused library.json: ${read.refusal?.detail}`);
  }
  return read.value;
}

interface Loaded {
  readonly world: HostWorld;
  readonly library: LoadedLibrary;
  readonly mirror: BoundDefinition;
  readonly walker: BoundDefinition;
}

function loaded(): Loaded {
  const standard = realStandard();
  const world = createHostWorld({}, { descriptionCheck: (description) => standard.checkDescription(description) });
  const library = alive(world.host.loadLibrary(declaration(), describedLibraryPath));
  const handles = registerDirectory(world, pluginDirectory([plugin({ importName: "holder", services: { consumes: [mirrorId, walkerId] } })]));
  const context = alive(world.host.open(handles.registered.get("holder")!));
  return {
    world,
    library,
    mirror: context.services.get(context.service(mirrorId)) as BoundDefinition,
    walker: context.services.get(context.service(walkerId)) as BoundDefinition,
  };
}

/** Whether `promise` has settled once `turns` rounds of microtasks have run after it was made. */
async function settledWithinMicrotasks(promise: Promise<unknown>, turns: number): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let turn = 0; turn < turns; turn++) {
    await Promise.resolve();
  }
  return settled;
}

/**
 * Runs `start` inside a socket's data callback, so it runs in the event loop's poll phase.
 *
 * @implNote A worker call answers through the loop's own I/O, which the poll phase that is running cannot reach again
 * before the check phase, so an immediate queued here runs before any answer the call posts; a call that ran on the
 * calling thread has already settled by then.
 */
function fromPollPhase<Answer>(start: () => Promise<Answer>): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      socket.once("data", () => {
        start().then(resolve, reject);
        socket.end();
        server.close();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const client = connect((server.address() as AddressInfo).port, "127.0.0.1", () => client.end("go"));
      client.on("error", reject);
    });
  });
}

/** How many blocks koffi allocated while `run` ran, and how many of those it freed again. */
async function blocksDuring(run: () => Promise<void>): Promise<{ allocated: number; freed: number }> {
  const live = new Set<object>();
  const counts = { allocated: 0, freed: 0 };
  const alloc = koffi.alloc.bind(koffi) as (...parameters: unknown[]) => object;
  const free = koffi.free.bind(koffi) as (block: object) => void;
  vi.spyOn(koffi, "alloc").mockImplementation(((...parameters: unknown[]) => {
    const block = alloc(...parameters);
    live.add(block);
    counts.allocated += 1;
    return block;
  }) as typeof koffi.alloc);
  vi.spyOn(koffi, "free").mockImplementation(((block: object) => {
    if (live.delete(block)) {
      counts.freed += 1;
    }
    free(block);
  }) as typeof koffi.free);
  try {
    await run();
  } finally {
    vi.restoreAllMocks();
  }
  return counts;
}

describe("an operation its description marks blocking", () => {
  it("answers as described, a u64 beyond 2^53 as a bigint and one within it as a number", async () => {
    const { walker } = loaded();

    expect(await walker.wait!({ ticks: 9007199254740993n })).toBe(9007199254740993n);
    expect(await walker.wait!({ ticks: 7 })).toBe(7);
  });

  it("is reported blocking on its bound object, in the description's order, and no other operation is", () => {
    const { mirror, walker } = loaded();

    expect(blockingOperationsOf(walker)).toEqual(["wait"]);
    expect(blockingOperationsOf(mirror)).toEqual([]);
    expect(Object.isFrozen(blockingOperationsOf(walker))).toBe(true);
    expect(blockingOperationsOf({})).toBeUndefined();
  });

  it("is still running once every microtask has run, so the calling thread went back to the event loop", async () => {
    const { walker } = loaded();

    expect(await settledWithinMicrotasks(walker.wait!({ ticks: 1 }), 20)).toBe(false);
  });

  it("leaves the event loop free while it runs: an immediate queued before the call fires before it answers", async () => {
    const { walker } = loaded();
    const order: string[] = [];

    await fromPollPhase(async () => {
      setImmediate(() => order.push("immediate"));
      const call = walker.wait!({ ticks: 3 }).then((waited) => order.push(`answered ${String(waited)}`));
      await call;
    });

    expect(order).toEqual(["immediate", "answered 3"]);
  });

  it("answers two overlapping calls each with its own answer", async () => {
    const { walker } = loaded();

    const first = walker.wait!({ ticks: 11 });
    const second = walker.wait!({ ticks: 9007199254740995n });

    expect(await Promise.all([first, second])).toEqual([11, 9007199254740995n]);
  });

  it("frees every block it allocated for a call, the calls that answered and the one refused before calling alike", async () => {
    const { walker } = loaded();

    const blocks = await blocksDuring(async () => {
      await Promise.all([walker.wait!({ ticks: 1 }), walker.wait!({ ticks: 2 })]);
      await expect(walker.wait!({ ticks: "many" })).rejects.toBeInstanceOf(TypeError);
    });

    expect(blocks.allocated).toBeGreaterThanOrEqual(3);
    expect(blocks.freed).toBe(blocks.allocated);
  });

  it("refuses a call once the binary has closed, and closes the binary only once a running call has returned", async () => {
    const { world, library, walker } = loaded();

    const running = walker.wait!({ ticks: 5 });
    library.unload();
    await world.host.destroy();

    await expect(running).rejects.toBeInstanceOf(LibraryUnloadedError);
    await expect(walker.wait!({ ticks: 5 })).rejects.toBeInstanceOf(LibraryUnloadedError);
  });
});

describe("an operation its description does not mark blocking", () => {
  it("still runs to its end on the calling thread, its promise settled before the next microtask", async () => {
    const { mirror } = loaded();

    expect(await settledWithinMicrotasks(mirror.grow!({ amount: 1 }), 1)).toBe(true);
  });
});
