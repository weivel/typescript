import koffi from "koffi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindDescribed } from "../../src/host/description/definition.ts";
import { HandleHoldings } from "../../src/host/description/handles.ts";
import { DescribedKind, DescribedReturn, DescribedRole } from "../../src/host/description/layout.ts";
import { readDescription, type DescribedParameter, type Description } from "../../src/host/description/reader.ts";
import { bindDefinition, OperationNotOfferedError, type BoundDefinition, type DescribedHandle } from "../../src/host/index.ts";
import { describedLibraryPath } from "./world.ts";

const pointerSize = koffi.sizeof("void *");
const lendPrototype = koffi.proto("int", ["void *", "void *"]);
const releasePrototype = koffi.proto("void", ["void *", "void *"]);
const binaries: koffi.IKoffiLib[] = [];
const registered: koffi.IKoffiRegisteredCallback[] = [];
const blocks: object[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  registered.splice(0).forEach((callback) => koffi.unregister(callback));
  blocks.splice(0).forEach((block) => koffi.free(block));
  binaries.splice(0).forEach((binary) => binary.unload());
});

function parameter(name: string, kind: number, role: number, element: number = DescribedKind.None, type: string | null = null, release: string | null = null): DescribedParameter {
  return { name, kind, role, element, type, count: null, release };
}

/**
 * A lender described by hand, whose `lend` answers a loan carrying the standard's described walker as a definition,
 * and whose `release_loan` says when it ran: a provider written in JavaScript, so a test can see the order in which
 * the binding releases a carried definition's answers and the answer that carried it.
 */
function lenderDescription(walker: Description): Description {
  const loan = parameter("loan", DescribedKind.Pointer, DescribedRole.Answer, DescribedKind.Struct, "loan");
  return {
    definition: "lender",
    types: [
      {
        name: "lender",
        size: 4 * pointerSize,
        firstShape: 4 * pointerSize,
        members: [
          { name: "size", offset: 0, size: 4, kind: DescribedKind.U32, element: 0, type: null, count: null, release: null },
          { name: "context", offset: pointerSize, size: pointerSize, kind: DescribedKind.Context, element: 0, type: null, count: null, release: null },
        ],
      },
      {
        name: "loan",
        size: 2 * pointerSize,
        firstShape: 2 * pointerSize,
        members: [
          { name: "size", offset: 0, size: 4, kind: DescribedKind.U32, element: 0, type: null, count: null, release: null },
          { name: "walker", offset: pointerSize, size: pointerSize, kind: DescribedKind.Definition, element: 0, type: walker.definition, count: null, release: null },
        ],
      },
    ],
    enums: [],
    operations: [
      {
        name: "lend",
        offset: 2 * pointerSize,
        returns: DescribedReturn.Status,
        parameters: [parameter("context", DescribedKind.Context, DescribedRole.Input), { ...loan, release: "release_loan" }],
      },
      { name: "release_loan", offset: 3 * pointerSize, returns: DescribedReturn.Nothing, parameters: [parameter("context", DescribedKind.Context, DescribedRole.Input), loan] },
    ],
    blocking: [],
    definitions: [walker],
  };
}

interface Lent {
  readonly lender: BoundDefinition;
  readonly mirror: BoundDefinition;
  /** What the lender's provider did, in order: each `release_loan` it ran. */
  readonly events: string[];
  /** The address of the walker's own `release_cursor`. */
  readonly releaseCursor: bigint;
  readonly releaseLoan: bigint;
  /** A copy of the walker's struct, which `lend` lends in place of the library's own when `lendingCopy` was asked. */
  readonly copy: object;
  readonly walker: Description;
  /** The library's walker bound as a library's service is, on the lender's holdings, so both are one library's. */
  readonly ownWalker: BoundDefinition;
}

function lent(lendingCopy = false): Lent {
  const binary = koffi.load(describedLibraryPath);
  binaries.push(binary);
  const symbol = (name: string): object => (binary.func(name, "void *", []) as () => object)();
  const walkerPointer = symbol("described_walker_definition");
  const walker = readDescription(symbol("described_walker_description"));
  const events: string[] = [];
  const walkerSize = koffi.decode(walkerPointer, "uint32_t") as number;
  const copy = koffi.alloc("uint8_t", walkerSize) as object;
  blocks.push(copy);
  koffi.encode(copy, 0, "uint8_t", koffi.decode(walkerPointer, 0, "uint8_t", walkerSize) as Uint8Array, walkerSize);
  const lend = koffi.register((_context: unknown, loan: object) => {
    koffi.encode(loan, pointerSize, "void *", lendingCopy ? copy : walkerPointer);
    return 0;
  }, koffi.pointer(lendPrototype));
  const releaseLoan = koffi.register(() => {
    events.push("loan released");
  }, koffi.pointer(releasePrototype));
  registered.push(lend, releaseLoan);
  const block = koffi.alloc("uint8_t", 4 * pointerSize) as object;
  blocks.push(block);
  koffi.encode(block, 0, "uint8_t", new Uint8Array(4 * pointerSize), 4 * pointerSize);
  koffi.encode(block, 0, "uint32_t", 4 * pointerSize);
  koffi.encode(block, 2 * pointerSize, "void *", lend);
  koffi.encode(block, 3 * pointerSize, "void *", releaseLoan);
  const releaseCursorOffset = walker.operations.find((operation) => operation.name === "release_cursor")!.offset;
  const holdings = new HandleHoldings();
  return {
    lender: bindDescribed({ definition: { library: "lender", pointer: block }, description: lenderDescription(walker), holdings, isOpen: () => true }),
    ownWalker: bindDescribed({ definition: { library: "lender", pointer: walkerPointer }, description: walker, holdings, isOpen: () => true }),
    mirror: bindDefinition(symbol("described_mirror_definition"), symbol("described_mirror_description")),
    events,
    releaseCursor: koffi.address(koffi.decode(walkerPointer, releaseCursorOffset, "void *") as object),
    releaseLoan: koffi.address(releaseLoan),
    copy,
    walker,
  };
}

interface Loan {
  readonly walker: BoundDefinition;
  release(): void;
}

async function cursorsReleased(mirror: BoundDefinition): Promise<bigint> {
  const counts = (await mirror.count_releases!()) as Record<string, number | bigint>;
  return BigInt(counts.cursors!);
}

describe("a definition an answer carried, once that answer is released", () => {
  it("refuses new calls at once, lets a running blocking call answer, and releases the answer only after that call returned", async () => {
    const { lender, events } = lent();
    const loan = (await lender.lend!()) as Loan;

    const running = loan.walker.wait!({ ticks: 9007199254740993n });
    loan.release();
    const refused = loan.walker.wait!({ ticks: 1 });

    expect(events).toEqual([]);
    await expect(refused).rejects.toBeInstanceOf(TypeError);
    expect(await running).toBe(9007199254740993n);
    expect(events).toEqual(["loan released"]);
  });

  it("first releases every handle and answer got through it, through its own releases, then the answer that carried it", async () => {
    const { lender, mirror, events, releaseCursor, releaseLoan } = lent();
    const before = await cursorsReleased(mirror);
    const loan = (await lender.lend!()) as Loan;
    const cursor = (await loan.walker.open!({ label: "walk", start: 3 })) as DescribedHandle;
    const inner = (await loan.walker.lend!()) as { counter: BoundDefinition };
    const called: bigint[] = [];
    const call = koffi.call.bind(koffi) as (...parameters: unknown[]) => unknown;
    vi.spyOn(koffi, "call").mockImplementation(((target: unknown, ...rest: unknown[]) => {
      called.push(koffi.address(target));
      return call(target, ...rest);
    }) as typeof koffi.call);

    loan.release();
    vi.restoreAllMocks();
    cursor.release();

    const order = called.filter((address) => address === releaseCursor || address === releaseLoan);
    expect(order).toEqual([releaseCursor, releaseLoan]);
    expect(events).toEqual(["loan released"]);
    expect(await cursorsReleased(mirror)).toBe(before + 1n);
    await expect(inner.counter.add!({ amount: 1 })).rejects.toBeInstanceOf(TypeError);
  });
});

describe("a definition lent again at the address of one released", () => {
  it("is called through what its struct holds now, never through what the released one held", async () => {
    const { lender, copy, walker } = lent(true);
    const first = (await lender.lend!()) as Loan;
    const opened = (await first.walker.open!({ label: "walk", start: 1 })) as DescribedHandle;
    opened.release();
    first.release();

    koffi.encode(copy, walker.operations.find((operation) => operation.name === "open")!.offset, "void *", null);
    const second = (await lender.lend!()) as Loan;

    await expect(second.walker.open!({ label: "walk", start: 1 })).rejects.toBeInstanceOf(OperationNotOfferedError);
    second.release();
  });
});

describe("a handle got through a definition an answer carried", () => {
  it("is taken by every definition of its library, the carried ones and the library's own alike, either way", async () => {
    const { lender, ownWalker } = lent();
    const first = (await lender.lend!()) as Loan;
    const second = (await lender.lend!()) as Loan;
    const fromCarried = (await first.walker.open!({ label: "carried", start: 4 })) as DescribedHandle;
    const fromOwn = (await ownWalker.open!({ label: "own", start: 6 })) as DescribedHandle;

    expect(await ownWalker.use!({ cursor: fromCarried })).toBe(4);
    expect(await second.walker.use!({ cursor: fromCarried })).toBe(4);
    expect(await first.walker.use!({ cursor: fromOwn })).toBe(6);
    first.release();
    second.release();
    fromOwn.release();
  });

  it("is released with the answer that carried the definition it was got through, and refused as released afterwards", async () => {
    const { lender, ownWalker } = lent();
    const loan = (await lender.lend!()) as Loan;
    const fromCarried = (await loan.walker.open!({ label: "carried", start: 4 })) as DescribedHandle;
    const fromOwn = (await ownWalker.open!({ label: "own", start: 6 })) as DescribedHandle;

    loan.release();

    await expect(ownWalker.use!({ cursor: fromCarried })).rejects.toThrow(/was handed a handle that has been released/);
    expect(await ownWalker.use!({ cursor: fromOwn })).toBe(6);
    fromOwn.release();
  });

  it("is refused, as one this library did not answer, by another library's definitions", async () => {
    const { lender } = lent();
    const other = lent();
    const loan = (await lender.lend!()) as Loan;
    const cursor = (await loan.walker.open!({ label: "carried", start: 4 })) as DescribedHandle;

    await expect(other.ownWalker.use!({ cursor })).rejects.toThrow(/takes a handle this library answered/);
    loan.release();
  });
});
