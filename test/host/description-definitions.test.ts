import { readFileSync } from "node:fs";
import { join } from "node:path";
import koffi from "koffi";
import { afterEach, describe, expect, it } from "vitest";
import { bindDefinition, blockingOperationsOf, DescribedCallError, type BoundDefinition, type LoadedLibrary } from "../../src/host/index.ts";
import type { LibraryDeclaration } from "../../src/standard/index.ts";
import { realStandard } from "../real-standard.ts";
import { alive, createHostWorld, describedLibraryPath, plugin, pluginDirectory, registerDirectory } from "./world.ts";

const fixtureDirectory = join(import.meta.dirname, "..", "..", "siblings", "standard", "test", "described");
const mirrorId = "described-mirror";
const walkerId = "described-walker";
const counterStart = 1000;
const refusedAmount = 13;
const binaries: koffi.IKoffiLib[] = [];

afterEach(() => {
  binaries.splice(0).forEach((binary) => binary.unload());
});

function declaration(): LibraryDeclaration {
  const read = realStandard().readLibrary(readFileSync(join(fixtureDirectory, "library.json"), "utf8"));
  if (read.value === undefined) {
    throw new Error(`the standard refused library.json: ${read.refusal?.detail}`);
  }
  return read.value;
}

interface Loaded {
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
    library,
    mirror: context.services.get(context.service(mirrorId)) as BoundDefinition,
    walker: context.services.get(context.service(walkerId)) as BoundDefinition,
  };
}

/** What `lend` answers: the loan, holding the counter bound, and the loan's own release. */
interface Loan {
  readonly counter: BoundDefinition;
  release(): void;
}

async function nestedRefusalsReleased(mirror: BoundDefinition): Promise<bigint> {
  const counts = (await mirror.count_releases!()) as Record<string, number | bigint>;
  return BigInt(counts.nested_refusals!);
}

describe("a definition an answer carries", () => {
  it("is bound and called through its own context, and reports none of the walker's blocking operations", async () => {
    const { walker } = loaded();

    const loan = (await walker.lend!()) as Loan;

    expect(Object.keys(loan)).toEqual(["counter"]);
    expect(Object.keys(loan.counter)).toEqual(["add"]);
    expect(Object.isFrozen(loan.counter)).toBe(true);
    expect(await loan.counter.add!({ amount: 5 })).toBe(counterStart + 5);
    expect(blockingOperationsOf(loan.counter)).toEqual([]);
    loan.release();
  });

  it("is refused as the caller's mistake once its answer is released, and a later answer carries a callable one again", async () => {
    const { walker } = loaded();
    const first = (await walker.lend!()) as Loan;

    first.release();
    first.release();
    const second = (await walker.lend!()) as Loan;

    await expect(first.counter.add!({ amount: 5 })).rejects.toBeInstanceOf(TypeError);
    expect(await second.counter.add!({ amount: 6 })).toBe(counterStart + 6);
    second.release();
  });

  it("frees its own refusal through its own release, once", async () => {
    const { mirror, walker } = loaded();
    const before = await nestedRefusalsReleased(mirror);
    const loan = (await walker.lend!()) as Loan;

    const refused = await loan.counter.add!({ amount: refusedAmount }).catch((error: unknown) => error);
    loan.release();

    expect(refused).toBeInstanceOf(DescribedCallError);
    expect(refused).toMatchObject({ operation: "add", status: 3 });
    expect(await nestedRefusalsReleased(mirror)).toBe(before + 1n);
  });

  it("ends with the unload when its holder never released the answer carrying it", async () => {
    const { library, walker } = loaded();
    const loan = (await walker.lend!()) as Loan;

    library.unload();

    await expect(loan.counter.add!({ amount: 1 })).rejects.toBeInstanceOf(TypeError);
  });
});

describe("binding a definition a host got some other way", () => {
  it("binds the walker from its struct and its checked description, a blocking wait and a carried counter included", async () => {
    const binary = koffi.load(describedLibraryPath);
    binaries.push(binary);
    const pointer = (binary.func("described_walker_definition", "void *", []) as () => object)();
    const description = (binary.func("described_walker_description", "void *", []) as () => object)();
    expect(realStandard().checkDescription(description, pointer).status).toBe(0);

    const walker = bindDefinition(pointer, description);
    const loan = (await walker.lend!()) as Loan;

    expect(blockingOperationsOf(walker)).toEqual(["wait"]);
    expect(await walker.wait!({ ticks: 4 })).toBe(4);
    expect(await loan.counter.add!({ amount: 2 })).toBe(counterStart + 2);
    loan.release();
    await expect(loan.counter.add!({ amount: 2 })).rejects.toBeInstanceOf(TypeError);
  });
});
