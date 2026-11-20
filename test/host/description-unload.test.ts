import { readFileSync } from "node:fs";
import { join } from "node:path";
import koffi from "koffi";
import { afterEach, describe, expect, it } from "vitest";
import { bindLibrary, type BoundLibrary } from "../../src/host/libraries.ts";
import { bindDefinition, type BoundDefinition, type DescribedHandle } from "../../src/host/index.ts";
import { realStandard } from "../real-standard.ts";
import { describedLibraryPath } from "./world.ts";

const fixtureDirectory = join(import.meta.dirname, "..", "..", "siblings", "standard", "test", "described");
const binaries: koffi.IKoffiLib[] = [];

afterEach(() => {
  binaries.splice(0).forEach((binary) => binary.unload());
});

interface Bound {
  readonly library: BoundLibrary;
  readonly walker: BoundDefinition;
  /** A mirror on a handle of the test's own, so the library's counts stay readable once the library is unmapped. */
  readonly counts: BoundDefinition;
  /** Each time the library's binary was unmapped. */
  readonly unmapped: string[];
}

function bound(): Bound {
  const standard = realStandard();
  const read = standard.readLibrary(readFileSync(join(fixtureDirectory, "library.json"), "utf8"));
  const unmapped: string[] = [];
  const library = bindLibrary(describedLibraryPath, read.value!, () => unmapped.push("unmapped"), (description) => standard.checkDescription(description));
  const binary = koffi.load(describedLibraryPath);
  binaries.push(binary);
  const symbol = (name: string): object => (binary.func(name, "void *", []) as () => object)();
  return {
    library,
    walker: library.described.get("described-walker")!,
    counts: bindDefinition(symbol("described_mirror_definition"), symbol("described_mirror_description")),
    unmapped,
  };
}

async function cursorsReleased(counts: BoundDefinition): Promise<bigint> {
  const answered = (await counts.count_releases!()) as Record<string, number | bigint>;
  return BigInt(answered.cursors!);
}

describe("unloading a library while a blocking call runs in it", () => {
  it("releases what its answers carried and what was got through them at once, answers the call, and only then unmaps", async () => {
    const { library, walker, counts, unmapped } = bound();
    const before = await cursorsReleased(counts);
    const loan = (await walker.lend!()) as { counter: BoundDefinition };
    const cursor = (await walker.open!({ label: "walk", start: 2 })) as DescribedHandle;

    const running = walker.wait!({ ticks: 8 });
    library.unload();

    expect(unmapped).toEqual([]);
    expect(await cursorsReleased(counts)).toBe(before + 1n);
    await expect(loan.counter.add!({ amount: 1 })).rejects.toBeInstanceOf(TypeError);
    expect(await running).toBe(8);
    expect(unmapped).toEqual(["unmapped"]);
    cursor.release();
    expect(await cursorsReleased(counts)).toBe(before + 1n);
  });

  it("releases an answer and a handle its holder released before the unload once, and unmaps once", async () => {
    const { library, walker, counts, unmapped } = bound();
    const before = await cursorsReleased(counts);
    const loan = (await walker.lend!()) as { counter: BoundDefinition; release(): void };
    const cursor = (await walker.open!({ label: "walk", start: 2 })) as DescribedHandle;

    loan.release();
    cursor.release();
    library.unload();
    library.close();

    expect(await cursorsReleased(counts)).toBe(before + 1n);
    expect(unmapped).toEqual(["unmapped"]);
    await expect(loan.counter.add!({ amount: 1 })).rejects.toBeInstanceOf(TypeError);
  });
});
