import koffi from "koffi";
import { afterEach, describe, expect, it } from "vitest";
import { CallArena } from "../../src/host/description/arena.ts";
import { HandleHoldings } from "../../src/host/description/handles.ts";
import { DescribedKind } from "../../src/host/description/layout.ts";
import { DescribedLayouts } from "../../src/host/description/layouts.ts";
import type { DescribedMember, Description } from "../../src/host/description/reader.ts";
import { StructWriter } from "../../src/host/description/structs.ts";

const pointerSize = koffi.sizeof("void *");
const arenas: CallArena[] = [];

afterEach(() => {
  arenas.splice(0).forEach((arena) => arena.free());
});

function pointerMember(name: string, offset: number, kind: number, type: string | null, element: number = DescribedKind.None): DescribedMember {
  return { name, offset, size: pointerSize, kind, element, type, count: null, release: null };
}

/** Two structs that point at each other, which no koffi struct can name both ways. */
const cycle: Description = {
  definition: "none",
  types: [
    { name: "ahead", size: pointerSize, firstShape: pointerSize, members: [pointerMember("next", 0, DescribedKind.Pointer, "behind", DescribedKind.Struct)] },
    {
      name: "behind",
      size: 2 * pointerSize,
      firstShape: 2 * pointerSize,
      members: [pointerMember("label", 0, DescribedKind.Text, null), pointerMember("back", pointerSize, DescribedKind.Pointer, "ahead", DescribedKind.Struct)],
    },
  ],
  enums: [],
  operations: [],
};

function writer(layouts: DescribedLayouts): StructWriter {
  const arena = new CallArena();
  arenas.push(arena);
  return new StructWriter({ layouts, holdings: new HandleHoldings(), freeHandle: () => {} }, arena);
}

describe("a struct reached through a cycle of structs", () => {
  it("is written into the arena with every text it holds, where koffi writes the rest of the call", () => {
    const layouts = new DescribedLayouts(cycle);
    const ahead = layouts.type("ahead");
    const behind = layouts.type("behind");

    const image = writer(layouts).image(ahead, { next: { label: "outer", back: { next: { label: "inner" } } } }, "input", true);

    expect(ahead.plans[0]!.marshalledByKoffi).toBe(true);
    expect(behind.plans[1]!.marshalledByKoffi).toBe(false);
    const next = image.next as { label: unknown; back: object };
    expect(next.label).toBe("outer");
    const back = koffi.decode(next.back, ahead.arenaType) as { next: object };
    const inner = koffi.decode(back.next, behind.arenaType) as { label: object; back: unknown };
    expect(koffi.decode(inner.label, "char", -1)).toBe("inner");
    expect(inner.back).toBeNull();
  });
});
