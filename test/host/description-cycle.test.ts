import koffi from "koffi";
import { afterEach, describe, expect, it } from "vitest";
import { CallArena } from "../../src/host/description/arena.ts";
import { HandleHoldings } from "../../src/host/description/handles.ts";
import { DescribedKind } from "../../src/host/description/layout.ts";
import { DescribedLayouts, type LaidOutType } from "../../src/host/description/layouts.ts";
import type { DescribedMember, DescribedType, Description } from "../../src/host/description/reader.ts";
import { StructWriter } from "../../src/host/description/structs.ts";

const pointerSize = koffi.sizeof("void *");
const sizeSize = koffi.sizeof("size_t");
const arenas: CallArena[] = [];

afterEach(() => {
  arenas.splice(0).forEach((arena) => arena.free());
});

function member(name: string, offset: number, kind: number, type: string | null = null, element: number = DescribedKind.None): DescribedMember {
  return { name, offset, size: pointerSize, kind, element, type, count: null, release: null };
}

function pointerTo(name: string, offset: number, type: string): DescribedMember {
  return member(name, offset, DescribedKind.Pointer, type, DescribedKind.Struct);
}

function struct(name: string, members: readonly DescribedMember[]): DescribedType {
  const size = Math.max(...members.map((each) => each.offset + each.size));
  return { name, size, firstShape: size, members };
}

function description(types: readonly DescribedType[]): Description {
  return { definition: "none", types, enums: [], operations: [], blocking: [], definitions: [] };
}

/** Both orders a description can list two structs in: whatever the binding decides must not depend on it. */
function bothOrders(types: readonly DescribedType[]): [string, Description][] {
  return [
    ["as declared", description(types)],
    ["reversed", description([...types].reverse())],
  ];
}

const libc = koffi.load(process.platform === "win32" ? "msvcrt.dll" : process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6");
const comparison = koffi.proto("int", ["const void *", "const void *"]);

/**
 * Hands `object` to C as a `type` exactly as an operation's input parameter is handed, as a pointer koffi writes
 * through the type's call type during the call, and reads it back inside that call, while the memory koffi wrote it
 * into is still alive.
 *
 * @implNote The C function is the C library's qsort, over two copies, since its comparison is the one callback every
 * platform's C library offers; koffi itself crashes calling back into a callback it registered.
 */
function throughC<Answer>(layouts: DescribedLayouts, type: LaidOutType, object: unknown, read: (pointer: object) => Answer): Answer {
  const arena = new CallArena();
  arenas.push(arena);
  const image = new StructWriter({ layouts, holdings: new HandleHoldings(), freeHandle: () => {}, bindCarried: () => { throw new Error("these structs carry no definition"); } }, arena).image(type, object, "input", true);
  const qsort = libc.func("qsort", "void", [koffi.pointer(type.callType), "size_t", "size_t", koffi.pointer(comparison)]) as (...parameters: unknown[]) => void;
  let answer: Answer | undefined;
  qsort([image, image], 2, type.described.size, (left: object) => {
    answer ??= read(left);
    return 0;
  });
  return answer!;
}

function textAt(base: object, offset: number): string | null {
  const pointer = koffi.decode(base, offset, "void *") as object | null;
  return pointer === null ? null : (koffi.decode(pointer, "char", -1) as string);
}

function pointerAt(base: object, offset: number): object {
  return koffi.decode(base, offset, "void *") as object;
}

describe("a struct pointing at itself", () => {
  it("is written by koffi through its own name, every link and its text with it", () => {
    const link = struct("link", [member("label", 0, DescribedKind.Text), pointerTo("next", pointerSize, "link")]);
    const layouts = new DescribedLayouts(description([link]));
    const type = layouts.type("link");

    const labels = throughC(layouts, type, { label: "first", next: { label: "second", next: { label: "third" } } }, (pointer) => {
      const read: (string | null)[] = [];
      for (let at: object | null = pointer; at !== null; at = koffi.decode(at, pointerSize, "void *") as object | null) {
        read.push(textAt(at, 0));
      }
      return read;
    });

    expect(type.plans.find((plan) => plan.member.name === "next")!.marshalledByKoffi).toBe(true);
    expect(labels).toEqual(["first", "second", "third"]);
  });
});

describe("two structs pointing at each other", () => {
  const ahead = struct("ahead", [pointerTo("next", 0, "behind")]);
  const behind = struct("behind", [member("label", 0, DescribedKind.Text), pointerTo("back", pointerSize, "ahead")]);

  for (const [order, cycle] of bothOrders([ahead, behind])) {
    it(`reach C whole, the text two structs down included, whichever is listed first (${order})`, () => {
      const layouts = new DescribedLayouts(cycle);

      const read = throughC(layouts, layouts.type("ahead"), { next: { label: "outer", back: { next: { label: "inner" } } } }, (pointer) => {
        const outer = pointerAt(pointer, 0);
        const inner = pointerAt(pointerAt(outer, pointerSize), 0);
        return [textAt(outer, 0), textAt(inner, 0), koffi.decode(inner, pointerSize, "void *")];
      });

      expect(read).toEqual(["outer", "inner", null]);
    });
  }
});

describe("a struct embedding one that points back at it", () => {
  const header = struct("header", [
    member("label", 0, DescribedKind.Text),
    { ...member("tags", pointerSize, DescribedKind.Texts), count: "tag_count" },
    { ...member("tag_count", 2 * pointerSize, DescribedKind.Size), size: sizeSize },
    pointerTo("owner", 3 * pointerSize, "node"),
    pointerTo("leaf", 4 * pointerSize, "leaf"),
  ]);
  const node = struct("node", [{ ...member("head", 0, DescribedKind.Struct, "header"), size: header.size }]);
  const leaf = struct("leaf", [member("name", 0, DescribedKind.Text)]);

  for (const [order, embedding] of bothOrders([header, node, leaf])) {
    it(`reaches C whole through the embedded copy's texts and pointer, whichever is listed first (${order})`, () => {
      const layouts = new DescribedLayouts(embedding);
      const input = { label: "outer", owner: { head: { label: "inner", tags: ["a", "b"], leaf: { name: "deep" } } } };

      const read = throughC(layouts, layouts.type("header"), input, (pointer) => {
        const head = pointerAt(pointer, 3 * pointerSize);
        const tags = pointerAt(head, pointerSize);
        return {
          outer: textAt(pointer, 0),
          inner: textAt(head, 0),
          tags: [textAt(tags, 0), textAt(tags, pointerSize)],
          count: Number(koffi.decode(head, 2 * pointerSize, "size_t")),
          deep: textAt(pointerAt(head, 4 * pointerSize), 0),
        };
      });

      expect(read).toEqual({ outer: "outer", inner: "inner", tags: ["a", "b"], count: 2, deep: "deep" });
    });
  }
});
