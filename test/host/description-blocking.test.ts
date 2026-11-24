import { readFileSync } from "node:fs";
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
  const world = createHostWorld({}, { descriptionCheck: (description, definition) => standard.checkDescription(description, definition) });
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
 * Whether an immediate queued before `calls` calls of the walker's `wait`, each awaited before the next, fired before
 * the last of them answered.
 *
 * @implNote Which of an immediate and one worker answer comes first is the runtime's order (Node answers in its poll
 * phase, Bun ahead of its immediates), so the run is long enough for the loop to turn on either; calls answered on the
 * calling thread settle within microtasks and leave the loop no turn at all.
 */
async function immediateFiresAmong(walker: BoundDefinition, calls: number): Promise<boolean> {
  let fired = false;
  setImmediate(() => (fired = true));
  for (let call = 0; call < calls; call++) {
    await walker.wait!({ ticks: call });
  }
  return fired;
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

  it("leaves the event loop free while it runs: an immediate queued before a run of calls fires before the run has answered", async () => {
    const { walker } = loaded();

    expect(await immediateFiresAmong(walker, 10)).toBe(true);
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

  it("answers a call running when the binary closed, and refuses every call made after", async () => {
    const { world, library, walker } = loaded();

    const running = walker.wait!({ ticks: 5 });
    library.unload();
    await world.host.destroy();

    expect(await running).toBe(5);
    await expect(walker.wait!({ ticks: 5 })).rejects.toBeInstanceOf(LibraryUnloadedError);
  });
});

describe("an operation its description does not mark blocking", () => {
  it("still runs to its end on the calling thread, its promise settled before the next microtask", async () => {
    const { mirror } = loaded();

    expect(await settledWithinMicrotasks(mirror.grow!({ amount: 1 }), 1)).toBe(true);
  });
});
