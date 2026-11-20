import koffi from "koffi";
import { afterEach, describe, expect, it } from "vitest";
import { standardStructs } from "../../src/standard/declarations.ts";
import { CallArena } from "../../src/host/description/arena.ts";
import { contextOf } from "../../src/host/description/definition.ts";
import { HandleHoldings } from "../../src/host/description/handles.ts";
import { DescribedKind } from "../../src/host/description/layout.ts";
import { DescribedLayouts, type LaidOutType } from "../../src/host/description/layouts.ts";
import type { DescribedMember, DescribedType } from "../../src/host/description/reader.ts";
import { Carried, StructWriter, viewOf } from "../../src/host/description/structs.ts";
import { readValue } from "../../src/host/description/values.ts";

const pointerSize = koffi.sizeof("void *");
const blocks: object[] = [];
const arenas: CallArena[] = [];

afterEach(() => {
  blocks.splice(0).forEach((block) => koffi.free(block));
  arenas.splice(0).forEach((arena) => arena.free());
});

function member(name: string, offset: number, kind: number, type: string | null = null, element: number = DescribedKind.None): DescribedMember {
  return { name, offset, size: kind === DescribedKind.U32 ? 4 : pointerSize, kind, element, type, count: null, release: null };
}

function laidOut(type: DescribedType): LaidOutType {
  return new DescribedLayouts({ definition: type.name, types: [type], enums: [], operations: [], blocking: [], definitions: [] }).type(type.name);
}

const linkType: DescribedType = {
  name: "link",
  size: 2 * pointerSize,
  firstShape: 2 * pointerSize,
  members: [member("label", 0, DescribedKind.Text), member("next", pointerSize, DescribedKind.Pointer, "link", DescribedKind.Struct)],
};

function writer(type: LaidOutType): StructWriter {
  const arena = new CallArena();
  arenas.push(arena);
  return new StructWriter({ layouts: new DescribedLayouts({ definition: type.described.name, types: [type.described], enums: [], operations: [], blocking: [], definitions: [] }), holdings: new HandleHoldings(), freeHandle: () => {}, bindCarried: () => { throw new Error("these structs carry no definition"); } }, arena);
}

/** A link with `below` links nested below it, each the one before's `next`. */
function chain(below: number): Record<string, unknown> {
  let link: Record<string, unknown> = { label: "last" };
  for (let index = 0; index < below; index += 1) {
    link = { label: "link", next: link };
  }
  return link;
}

function allocated(byteSize: number): object {
  const block = koffi.alloc("uint8_t", byteSize) as object;
  blocks.push(block);
  koffi.encode(block, 0, "uint8_t", new Uint8Array(byteSize), byteSize);
  return block;
}

/** `count` links in native memory, each pointing at the next and the last at nothing; answers the first. */
function nativeChain(count: number): object {
  let next: object | null = null;
  for (let index = 0; index < count; index += 1) {
    const link = allocated(2 * pointerSize);
    koffi.encode(link, pointerSize, "void *", next);
    next = link;
  }
  return next!;
}

function depthOf(read: Record<string, unknown>): number {
  let depth = 0;
  for (let at = read.next as Record<string, unknown> | undefined; at !== undefined; at = at.next as Record<string, unknown> | undefined) {
    depth += 1;
  }
  return depth;
}

/**
 * Runs `run` with only about `spareFrames` frames of a small recursive function left on the stack, so a walk that
 * recursed once per struct would overflow it.
 */
function withLittleStackLeft<Answer>(spareFrames: number, run: () => Answer): Answer {
  let reached = 0;
  let answer: Answer | undefined;
  const descend = (left: number, atTheBottom: (() => void) | undefined): void => {
    reached += 1;
    if (left === 0) {
      atTheBottom!();
      return;
    }
    descend(left - 1, atTheBottom);
  };
  try {
    descend(Number.MAX_SAFE_INTEGER, undefined);
  } catch {
    // The stack ran out, which is what measured it.
  }
  descend(reached - spareFrames, () => {
    answer = run();
  });
  return answer!;
}

describe("structs nested in a call's input", () => {
  for (const inCall of [true, false]) {
    it(`are written 1000 levels deep and refused one level deeper, as the caller's mistake (${inCall ? "by koffi" : "into the arena"})`, () => {
      const type = laidOut(linkType);

      expect(() => writer(type).image(type, chain(1000), "input", inCall)).not.toThrow();
      expect(() => writer(type).image(type, chain(1001), "input", inCall)).toThrow(TypeError);
      expect(() => writer(type).image(type, chain(1001), "input", inCall)).toThrow(/input(\.next){1001} nests structs deeper than 1000 levels/);
    });
  }

  it("are refused at the limit however little stack the caller left", () => {
    const type = laidOut(linkType);

    expect(() => withLittleStackLeft(400, () => writer(type).image(type, chain(1001), "input", false))).toThrow(/nests structs deeper than 1000 levels/);
  });
});

describe("structs nested in a provider's answer", () => {
  it("are read 1000 levels deep and refused one level deeper, as the provider's fault", () => {
    const type = laidOut(linkType);
    const read = (count: number) => {
      const first = nativeChain(count);
      return writer(type).readStruct(first, viewOf(first, type.described.size), 0, type, new Carried());
    };

    expect(depthOf(read(1001))).toBe(1000);
    expect(() => read(1002)).toThrow(/The provider answered structs nested deeper than 1000 levels/);
    expect(() => read(1002)).not.toThrow(TypeError);
  });

  it("are read 1000 levels deep however little stack the caller left", () => {
    const type = laidOut(linkType);
    const first = nativeChain(1001);

    expect(depthOf(withLittleStackLeft(400, () => writer(type).readStruct(first, viewOf(first, type.described.size), 0, type, new Carried())))).toBe(1000);
  });
});

describe("a value tree a provider answers", () => {
  it("is refused when a record holds a key twice", () => {
    const node = standardStructs.weivel_standard_value;
    const entry = standardStructs.weivel_standard_entry;
    const key = allocated(2);
    koffi.encode(key, 0, "uint8_t", new Uint8Array([0x61, 0]), 2);
    const entries = allocated(2 * koffi.sizeof(entry));
    const number = { kind: 3, boolean: 0, number: 1, text: null, length: 0, items: null, entries: null, count: 0 };
    koffi.encode(entries, 0, entry, { key, key_length: 1, value: number });
    koffi.encode(entries, koffi.sizeof(entry), entry, { key, key_length: 1, value: { ...number, number: 2 } });
    const root = allocated(koffi.sizeof(node));
    koffi.encode(root, 0, node, { kind: 6, boolean: 0, number: 0, text: null, length: 0, items: null, entries, count: 2 });

    expect(() => readValue(root, 0)).toThrow(/a record holding the key "a" twice/);
  });
});

describe("a definition's context", () => {
  const holder: DescribedType = {
    name: "holder",
    size: 2 * pointerSize,
    firstShape: 2 * pointerSize,
    members: [member("size", 0, DescribedKind.U32), member("context", pointerSize, DescribedKind.Context)],
  };

  it("is read inside the size the definition answered, and is none past it", () => {
    const type = laidOut(holder);
    const definition = allocated(2 * pointerSize);
    const context = allocated(1);
    koffi.encode(definition, pointerSize, "void *", context);

    expect(koffi.address(contextOf(definition, 2 * pointerSize, type)!)).toBe(koffi.address(context));
    expect(contextOf(definition, 2 * pointerSize - 1, type)).toBeNull();
    expect(contextOf(definition, pointerSize, type)).toBeNull();
  });
});
