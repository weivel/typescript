import { readFileSync } from "node:fs";
import { join } from "node:path";
import koffi from "koffi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddedNulError } from "../../src/core/index.ts";
import { RefusalError } from "../../src/context/index.ts";
import {
  boundDefinitionOf,
  DescribedCallError,
  LibraryUnloadedError,
  none,
  type BoundDefinition,
  type DescribedHandle,
  type LoadedLibrary,
} from "../../src/host/index.ts";
import type { LibraryDeclaration } from "../../src/standard/index.ts";
import { realStandard } from "../real-standard.ts";
import { activated, alive, createHostWorld, describedLibraryPath, plugin, pluginDirectory, registerDirectory, type HostWorld } from "./world.ts";

const fixtureDirectory = join(import.meta.dirname, "..", "..", "siblings", "standard", "test", "described");
const mirrorId = "described-mirror";
const walkerId = "described-walker";
const refusalDetail = "described refused on purpose";
const refusalFix = 'pass anything but "refuse"';

afterEach(() => {
  vi.restoreAllMocks();
});

/** One of the standard's declarations of its described test library, read by the standard itself. */
function declaration(file = "library.json"): LibraryDeclaration {
  const read = realStandard().readLibrary(readFileSync(join(fixtureDirectory, file), "utf8"));
  if (read.value === undefined) {
    throw new Error(`the standard refused ${file}: ${read.refusal?.detail}`);
  }
  return read.value;
}

function checkedWorld(): HostWorld {
  const standard = realStandard();
  return createHostWorld({}, { descriptionCheck: (description) => standard.checkDescription(description) });
}

interface Loaded {
  readonly world: HostWorld;
  readonly library: LoadedLibrary;
  readonly mirror: BoundDefinition;
  readonly walker: BoundDefinition;
}

/** The described library loaded on a host given the standard's check, with both bound objects as a holder gets them. */
function loaded(): Loaded {
  const world = checkedWorld();
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

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the call resolved");
}

async function cursorsReleased(mirror: BoundDefinition): Promise<bigint> {
  const counts = (await mirror.count_releases!()) as Record<string, number | bigint>;
  return BigInt(counts.cursors!);
}

function loadError(file: string, world: HostWorld = checkedWorld()): unknown {
  try {
    world.host.loadLibrary(declaration(file), describedLibraryPath);
  } catch (error) {
    return error;
  }
  throw new Error(`${file} loaded`);
}

describe("a library declaration read by the standard", () => {
  it("carries each service's description symbol, and none for a service that declares none", () => {
    const read = declaration();
    const mirrorAlone = realStandard().readLibrary(
      JSON.stringify({ importName: "described", version: "1.0.0", services: [{ id: mirrorId, functions: read.services[0]!.functions.map((declared) => ({ ...declared, kind: "definition", context: undefined })) }] }),
    );

    expect(read.services.map((service) => typeof service.description)).toEqual(["string", "string"]);
    expect(read.services[0]!.description).not.toBe(read.services[1]!.description);
    expect(mirrorAlone.value?.services[0]).not.toHaveProperty("description");
  });
});

describe("a described definition loaded through the host", () => {
  it("is served to a plugin as an object of one async method per operation, the releases left out", async () => {
    const world = checkedWorld();
    alive(world.host.loadLibrary(declaration(), describedLibraryPath));
    const handles = registerDirectory(
      world,
      pluginDirectory([
        plugin(
          { importName: "caller", services: { consumes: [mirrorId] } },
          `const mirror = context.services.get(context.service('${mirrorId}')); probe.methods = Object.keys(mirror); probe.found = await mirror.find({ key: 'alpha' });`,
        ),
      ]),
    );

    await activated(world.host, [...handles.registered.values()]);
    const reached = globalThis.weivelHostProbe as unknown as { methods: string[]; found: unknown };

    expect(reached.methods).toEqual(["reflect", "tree", "find", "measure", "negate", "halve", "invert", "swap_shade", "grow", "weigh", "count_releases"]);
    expect(reached.found).toBe("the first letter");
  });

  it("stands for the very struct its definition symbol answered, and is frozen", () => {
    const { library, mirror, walker } = loaded();

    expect(koffi.address(boundDefinitionOf(mirror)!.pointer)).toBe(koffi.address(library.definitions.get(mirrorId)!.pointer));
    expect(koffi.address(boundDefinitionOf(walker)!.pointer)).toBe(koffi.address(library.definitions.get(walkerId)!.pointer));
    expect(Object.isFrozen(mirror)).toBe(true);
    expect(mirror.find!({ key: "alpha" })).toBeInstanceOf(Promise);
    expect(boundDefinitionOf({})).toBeUndefined();
  });

  it("builds its layouts and prototypes at the load alone, never on a call", async () => {
    const { mirror } = loaded();
    const struct = vi.spyOn(koffi, "struct");
    const proto = vi.spyOn(koffi, "proto");

    await mirror.reflect!({ sample: { label: "once", points: [{ label: "p", x: 1, y: 2 }] } });
    await mirror.grow!({ amount: 1 });

    expect(struct).not.toHaveBeenCalled();
    expect(proto).not.toHaveBeenCalled();
  });
});

describe("loading a described library", () => {
  it("refuses, as the caller's mistake, a description whose offset disagrees with koffi's layout, which the check passes", () => {
    const world = checkedWorld();
    const error = loadError("library-broken-offset.json", world);

    expect(error).not.toBeInstanceOf(RefusalError);
    expect((error as Error).message).toMatch(/\.skip is described at offset (\d+) and size 8, where this platform lays it out at offset (\d+) and size 8/);
    const [, described, laidOut] = /offset (\d+) and size 8, where this platform lays it out at offset (\d+)/.exec((error as Error).message)!;
    expect(Number(described) - Number(laidOut)).toBe(4);
    expect(world.host.loadLibrary(declaration(), describedLibraryPath)).toBeDefined();
  });

  it("refuses a description the standard's check refuses, naming where", () => {
    const error = loadError("library-broken-count.json");

    expect(error).not.toBeInstanceOf(RefusalError);
    expect((error as Error).message).toMatch(/was refused by the check, status 2 at types\[1\]\.members\[3\]\.count/);
  });

  it("refuses a described library on a host given no check", () => {
    const error = loadError("library.json", createHostWorld());

    expect((error as Error).message).toMatch(/declares a description, and the host was given no descriptionCheck/);
  });
});

describe("a call through a described definition", () => {
  it("answers a u64 beyond 2^53 as a bigint and one within it as a number, and takes either", async () => {
    const { mirror } = loaded();

    expect(await mirror.grow!({ amount: 9007199254740993n })).toBe(9007199254740994n);
    expect(await mirror.grow!({ amount: 41 })).toBe(42);
    expect(await mirror.grow!({ amount: 9007199254740990 })).toBe(9007199254740991);
    expect(await mirror.grow!({ amount: 9007199254740991 })).toBe(9007199254740992n);
    expect(await mirror.negate!({ number: -9223372036854775807n })).toBe(9223372036854775807n);
    expect(await mirror.negate!({ number: 5 })).toBe(-5);
  });

  it("rejects an integer a number cannot hold exactly, or one outside its kind, before the call", async () => {
    const { mirror } = loaded();

    expect(await rejection(mirror.grow!({ amount: 2 ** 53 }))).toBeInstanceOf(TypeError);
    expect(await rejection(mirror.grow!({ amount: -1 }))).toBeInstanceOf(TypeError);
    expect(await rejection(mirror.grow!({ amount: 2n ** 64n }))).toBeInstanceOf(TypeError);
    expect(await rejection(mirror.negate!({ number: 2n ** 63n }))).toBeInstanceOf(TypeError);
    expect(await rejection(mirror.invert!({ flags: 2 ** 32 }))).toBeInstanceOf(TypeError);
    expect(await rejection(mirror.invert!({ flags: 1.5 }))).toBeInstanceOf(TypeError);
    expect(await rejection(mirror.halve!({ number: "1" }))).toBeInstanceOf(TypeError);
  });

  it("fills a count itself, and refuses a caller writing one or naming an input the operation does not take", async () => {
    const { mirror } = loaded();

    expect(await mirror.measure!({ bytes: new Uint8Array([1, 2, 255]) })).toBe(258);
    expect(await rejection(mirror.measure!({ bytes: new Uint8Array([1]), length: 1 }))).toBeInstanceOf(TypeError);
    expect(await rejection(mirror.reflect!({ sample: { tag_count: 1 } }))).toBeInstanceOf(TypeError);
    expect(await rejection(mirror.reflect!({ sample: { size: 1 } }))).toBeInstanceOf(TypeError);
    expect(await rejection(mirror.find!({ key: "alpha", other: 1 }))).toBeInstanceOf(TypeError);
  });

  it("answers a struct as an object, a value tree as a native value, texts, bytes and arrays as JavaScript's own", async () => {
    const { mirror } = loaded();
    const sample = {
      label: "a",
      tags: ["x", null],
      bytes: new Uint8Array([0, 255]),
      numbers: [1, 4294967295],
      held: { list: [1, "two", null, false], ["__proto__"]: "kept as a key" },
    };

    const reflected = (await mirror.reflect!({ sample })) as { sample: Record<string, unknown> };
    const tree = await mirror.tree!({ sample: { label: "t", ratio: 0.5 } });

    expect(reflected.sample.label).toBe("a");
    expect(reflected.sample.tags).toEqual(["x", null]);
    expect(reflected.sample.bytes).toEqual(new Uint8Array([0, 255]));
    expect(reflected.sample.numbers).toEqual([1, 4294967295]);
    expect(reflected.sample.held).toEqual(sample.held);
    expect(Object.keys(reflected.sample.held as object)).toEqual(["list", "__proto__"]);
    expect(Object.keys(reflected.sample)).not.toContain("best");
    expect(Object.keys(reflected.sample)).not.toContain("size");
    expect(tree).toEqual({ label: "t", tags: [], ratio: 0.5, held: null });
    expect(await mirror.weigh!({ value: [1, { a: [true] }] })).toBe(5);
  });

  it("resolves NONE as none, and rejects a refusal with its detail and fix and any other status with none", async () => {
    const { mirror } = loaded();

    expect(await mirror.find!({ key: "beta" })).toBe(none);
    const refused = await rejection(mirror.find!({ key: "refuse" }));
    const malformed = await rejection(mirror.find!({}));

    expect(refused).toBeInstanceOf(DescribedCallError);
    expect(refused).toMatchObject({ operation: "find", status: 3, detail: refusalDetail, fix: refusalFix });
    expect(malformed).toMatchObject({ operation: "find", status: 2, detail: null, fix: null });
  });

  it("rejects a text holding a NUL, and a value no tree holds, before the call", async () => {
    const { mirror } = loaded();

    expect(await rejection(mirror.find!({ key: "al\u0000pha" }))).toBeInstanceOf(EmbeddedNulError);
    expect(await rejection(mirror.weigh!({ value: [undefined] }))).toBeInstanceOf(TypeError);
    expect(await rejection(mirror.weigh!({ value: Number.NaN }))).toBeInstanceOf(TypeError);
    expect(await rejection(mirror.weigh!({ value: new Date() }))).toBeInstanceOf(TypeError);
  });

  it("refuses a call once the binary has closed", async () => {
    const { world, library, mirror } = loaded();
    library.unload();
    await world.host.destroy();

    expect(await rejection(mirror.find!({ key: "alpha" }))).toBeInstanceOf(LibraryUnloadedError);
  });
});

describe("a handle a described operation answered", () => {
  it("is an object with release(), handed back as an input, and released once however often release() is called", async () => {
    const { mirror, walker } = loaded();
    const before = await cursorsReleased(mirror);

    const cursor = (await walker.open!({ label: "walk", start: 7 })) as DescribedHandle;
    expect(Object.keys(cursor)).toEqual(["release"]);
    expect(await walker.use!({ cursor })).toBe(7);
    expect(await walker.visit!({ visit: { cursor, skip: 1, steps: [2, 3] } })).toBe(13);
    cursor.release();
    cursor.release();

    expect(await cursorsReleased(mirror)).toBe(before + 1n);
    expect(await rejection(walker.use!({ cursor }))).toBeInstanceOf(TypeError);
    expect(await rejection(walker.use!({ cursor: {} }))).toBeInstanceOf(TypeError);
  });

  it("is released by the unload when its holder never released it, and not again afterwards", async () => {
    const { library, mirror, walker } = loaded();
    const before = await cursorsReleased(mirror);
    const cursor = (await walker.open!({ label: "walk", start: 1 })) as DescribedHandle;

    library.unload();
    const afterUnload = await cursorsReleased(mirror);
    cursor.release();

    expect(afterUnload).toBe(before + 1n);
    expect(await cursorsReleased(mirror)).toBe(afterUnload);
  });
});
