import { readFileSync } from "node:fs";
import { join } from "node:path";
import koffi from "koffi";
import { afterEach, describe, expect, it } from "vitest";
import { bindDefinition, type BoundDefinition } from "../../src/host/description/definition.ts";
import { HandleHoldings } from "../../src/host/description/handles.ts";
import { DescribedKind, DescribedRole } from "../../src/host/description/layout.ts";
import { readDescription, type Description } from "../../src/host/description/reader.ts";
import { describedLibraryPath } from "./world.ts";

type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] extends object ? Mutable<Value[Key]> : Value[Key] };

const fixtureDirectory = join(import.meta.dirname, "..", "..", "siblings", "standard", "test", "described");
const binaries: koffi.IKoffiLib[] = [];
const blocks: object[] = [];

afterEach(() => {
  blocks.splice(0).forEach((block) => koffi.free(block));
  binaries.splice(0).forEach((binary) => binary.unload());
});

interface Mirror {
  readonly pointer: object;
  readonly description: Mutable<Description>;
}

/** The first service of the standard's described library: its struct and a mutable copy of its description. */
function mirror(): Mirror {
  const declared = JSON.parse(readFileSync(join(fixtureDirectory, "library.json"), "utf8")) as {
    services: { description: string; functions: { symbol: string }[] }[];
  };
  const service = declared.services[0]!;
  const binary = koffi.load(describedLibraryPath);
  binaries.push(binary);
  const pointer = (binary.func(service.functions[0]!.symbol, "void *", []) as () => object)();
  const description = readDescription((binary.func(service.description, "void *", []) as () => object)());
  return { pointer, description: structuredClone(description) as Mutable<Description> };
}

function bind(pointer: object, description: Description): BoundDefinition {
  return bindDefinition({ definition: { library: "described", pointer }, description, holdings: new HandleHoldings(), isOpen: () => true });
}

/** A copy of the definition's struct the test may change, `size` bytes of it read from the library's own. */
function copyOf(pointer: object, size: number): object {
  const block = koffi.alloc("uint8_t", size) as object;
  blocks.push(block);
  koffi.encode(block, 0, "uint8_t", koffi.decode(pointer, 0, "uint8_t", size) as Uint8Array, size);
  return block;
}

function definitionType(description: Mutable<Description>) {
  return description.types.find((type) => type.name === description.definition)!;
}

function offsetOf(description: Description, operation: string): number {
  return description.operations.find((candidate) => candidate.name === operation)!.offset;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("the call resolved");
}

describe("binding a description", () => {
  it("binds the real description unchanged", async () => {
    const { pointer, description } = mirror();

    expect(await bind(pointer, description).grow!({ amount: 1 })).toBe(2);
  });

  it("refuses a member whose array element is a kind this binding does not know, at the bind", () => {
    const { pointer, description } = mirror();
    const member = description.types.flatMap((type) => type.members).find((candidate) => candidate.kind === DescribedKind.Array)!;
    member.element = 99;

    expect(() => bind(pointer, description)).toThrow(/reaches elements of kind 99, which this binding does not know/);
  });

  it("refuses a parameter whose pointed element is a kind this binding does not know, at the bind", () => {
    const { pointer, description } = mirror();
    const parameter = description.operations
      .flatMap((operation) => operation.parameters)
      .find((candidate) => candidate.kind === DescribedKind.Pointer && candidate.role === DescribedRole.Input)!;
    parameter.element = 99;

    expect(() => bind(pointer, description)).toThrow(/reaches elements of kind 99, which this binding does not know/);
  });

  it("refuses a pointer whose struct element the description does not describe, at the bind", () => {
    const { pointer, description } = mirror();
    const member = description.types.flatMap((type) => type.members).find((candidate) => candidate.kind === DescribedKind.Pointer && candidate.element === DescribedKind.Struct)!;
    member.type = "nothing_described";

    expect(() => bind(pointer, description)).toThrow(/names nothing_described as a struct and describes none/);
  });

  it("offers no operation past the size its definition answered, and every one before it", async () => {
    const { pointer, description } = mirror();
    const size = definitionType(description).size;
    const ending = offsetOf(description, "grow");
    const copy = copyOf(pointer, size);
    koffi.encode(copy, 0, "uint32_t", ending);
    definitionType(description).firstShape = ending;
    const bound = bind(copy, description);

    expect(await bound.halve!({ number: 3 })).toBe(1.5);
    expect((await rejection(bound.grow!({ amount: 1 }))).message).toMatch(/provider does not offer grow/);
    expect((await rejection(bound.count_releases!())).message).toMatch(/provider does not offer count_releases/);
  });

  it("offers no operation the definition holds NULL for", async () => {
    const { pointer, description } = mirror();
    const copy = copyOf(pointer, definitionType(description).size);
    koffi.encode(copy, offsetOf(description, "halve"), "void *", null);
    const bound = bind(copy, description);

    expect((await rejection(bound.halve!({ number: 3 }))).message).toMatch(/provider does not offer halve/);
    expect(await bound.grow!({ amount: 1 })).toBe(2);
  });
});
