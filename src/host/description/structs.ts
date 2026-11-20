import koffi from "koffi";
import { EmbeddedNulError } from "../../core/text.js";
import type { CallArena } from "./arena.js";
import type { DescribedHandle, HandleHoldings } from "./handles.js";
import { DescribedKind } from "./layout.js";
import type { DescribedLayouts, LaidOutType, MemberPlan, ReachPlan } from "./layouts.js";
import { scalarForC, scalarFromC, scalarTypes } from "./scalars.js";
import { readValue, valueImage, valueKindOffset, writeValue } from "./values.js";

/** Frees a handle of the type it is named for, through the release the description names. */
export type HandleRelease = (release: string | null, pointer: object) => void;

/** What one call reaches while it writes and reads structs: the layouts, the arena, and the library's handles. */
export interface StructContext {
  readonly layouts: DescribedLayouts;
  readonly holdings: HandleHoldings;
  readonly freeHandle: HandleRelease;
}

const pointerSize = koffi.sizeof("void *");
const sizeSize = koffi.sizeof("size_t");
export const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** What a reached kind is handed to koffi as, and how many it counts. */
export interface Written {
  readonly value: unknown;
  readonly count: number;
}

const nothingWritten: Written = { value: null, count: 0 };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);
}

/** @throws TypeError naming the first key of `given` that is not one of `known`. */
export function refuseUnknownNames(given: Record<string, unknown>, known: readonly string[], where: string): void {
  const unknown = Object.keys(given).find((key) => !known.includes(key));
  if (unknown !== undefined) {
    throw new TypeError(`${where} has no ${unknown} a caller writes; it takes ${known.length === 0 ? "nothing" : known.join(", ")}.`);
  }
}

const visibleNames = new WeakMap<LaidOutType, readonly string[]>();

function visibleNamesOf(type: LaidOutType): readonly string[] {
  let names = visibleNames.get(type);
  if (names === undefined) {
    names = type.visible.map((member) => member.name);
    visibleNames.set(type, names);
  }
  return names;
}

/** Whether the pointer stored at `at` of `view` is NULL. */
function isNullAt(view: DataView, at: number): boolean {
  return pointerSize === 8 ? view.getBigUint64(at, littleEndian) === 0n : view.getUint32(at, littleEndian) === 0;
}

function sizeAt(view: DataView, at: number): number {
  return Number(sizeSize === 8 ? view.getBigUint64(at, littleEndian) : view.getUint32(at, littleEndian));
}

/** The scalar of `kind` stored at `at` of `view`, read without a call into koffi. */
export function scalarAt(view: DataView, at: number, kind: number): unknown {
  switch (kind) {
    case DescribedKind.U32:
      return view.getUint32(at, littleEndian);
    case DescribedKind.U64:
      return scalarFromC(kind, view.getBigUint64(at, littleEndian));
    case DescribedKind.I64:
      return scalarFromC(kind, view.getBigInt64(at, littleEndian));
    case DescribedKind.F64:
      return view.getFloat64(at, littleEndian);
    default:
      return scalarFromC(kind, sizeSize === 8 ? view.getBigUint64(at, littleEndian) : view.getUint32(at, littleEndian));
  }
}

/** A DataView over `length` bytes of native memory at `pointer`, which it aliases rather than copies. */
export function viewOf(pointer: object, length: number): DataView {
  return new DataView(koffi.view(pointer, length));
}

/**
 * Writes and reads the structs of one call, by the plans its definition was bound with.
 *
 * @implNote A struct is written as one JavaScript image that koffi encodes in the call itself through the struct's
 * call type, texts, arrays and the structs they reach included, and read through a DataView over its memory, so a
 * scalar costs no call into koffi. What koffi cannot write from a value, a value tree and a struct reached through a
 * cycle of structs, is written into the call's arena and handed to koffi as an address.
 */
export class StructWriter {
  constructor(
    readonly context: StructContext,
    readonly arena: CallArena,
  ) {}

  /**
   * `object` as a `type`, its leading size set, a member it leaves out at its zero: koffi writes it through the type's
   * call type when `inCall`, and through its arena type otherwise.
   *
   * @throws TypeError for anything but a plain object, a member the type does not let a caller write, or a value its
   * member's kind does not hold.
   */
  image(type: LaidOutType, object: unknown, where: string, inCall: boolean): Record<string, unknown> {
    const image: Record<string, unknown> = {};
    if (type.leadingSize) {
      image.size = type.described.size;
    }
    if (object === undefined) {
      return image;
    }
    if (!isPlainObject(object)) {
      throw new TypeError(`${where} is a ${type.described.name}, written as a plain object.`);
    }
    refuseUnknownNames(object, visibleNamesOf(type), where);
    for (const plan of type.plans) {
      this.#memberImage(image, plan, object[plan.member.name], `${where}.${plan.member.name}`, inCall);
    }
    return image;
  }

  #memberImage(image: Record<string, unknown>, plan: MemberPlan, value: unknown, where: string, inCall: boolean): void {
    const { member } = plan;
    const scalar = scalarTypes[member.kind];
    if (scalar !== undefined) {
      image[member.name] = scalarForC(member.kind, value, where);
      return;
    }
    if (member.kind === DescribedKind.Struct) {
      image[member.name] = this.image(plan.target!, value, where, inCall);
      return;
    }
    if (member.kind === DescribedKind.Value) {
      const node = valueImage(this.arena, value);
      if (node !== undefined) {
        image[member.name] = node;
      }
      return;
    }
    const written = this.written(plan, value, where, inCall);
    image[member.name] = written.value;
    if (plan.count !== null) {
      image[plan.count.name] = written.count;
    }
  }

  /**
   * What a pointer-sized member or parameter `plan` reaches is handed to koffi as, and how many it counts: the
   * JavaScript value koffi writes when `inCall` and the plan lets it, an address in the arena otherwise. A left-out
   * value is NULL with a count of 0.
   */
  written(plan: ReachPlan, value: unknown, where: string, inCall: boolean): Written {
    const byKoffi = inCall && plan.marshalledByKoffi;
    switch (plan.reached.kind) {
      case DescribedKind.Text:
        return { value: byKoffi ? checkedText(value, where) : this.#arenaText(value, where), count: 0 };
      case DescribedKind.Texts:
        return this.#texts(value, where, byKoffi);
      case DescribedKind.Bytes:
        return this.#bytes(value, where, byKoffi);
      case DescribedKind.Pointer:
        return { value: this.#pointed(plan, value, where, byKoffi), count: 0 };
      case DescribedKind.Array:
        return this.#array(plan, value, where, byKoffi);
      case DescribedKind.Handle:
        return {
          value: value === undefined || value === null ? null : this.context.holdings.pointerOf(value, plan.reached.type!, where),
          count: 0,
        };
      default:
        if (value !== undefined) {
          throw new TypeError(`${where} is the provider's own, and a caller writes nothing there.`);
        }
        return nothingWritten;
    }
  }

  #arenaText(value: unknown, where: string): object | null {
    const text = checkedText(value, where);
    return text === null ? null : this.arena.text(text);
  }

  #texts(value: unknown, where: string, byKoffi: boolean): Written {
    const texts = arrayOf(value, where);
    if (texts.length === 0) {
      return nothingWritten;
    }
    if (byKoffi) {
      return { value: texts.map((text, index) => checkedText(text, `${where}[${index}]`)), count: texts.length };
    }
    const block = this.arena.allocate(texts.length * pointerSize);
    texts.forEach((text, index) => koffi.encode(block, index * pointerSize, "void *", this.#arenaText(text, `${where}[${index}]`)));
    return { value: block, count: texts.length };
  }

  #bytes(value: unknown, where: string, byKoffi: boolean): Written {
    if (value === undefined) {
      return nothingWritten;
    }
    if (!(value instanceof Uint8Array)) {
      throw new TypeError(`${where} is bytes, written as a Uint8Array.`);
    }
    if (value.length === 0) {
      return nothingWritten;
    }
    return { value: byKoffi ? value : this.arena.bytes(value), count: value.length };
  }

  #pointed(plan: ReachPlan, value: unknown, where: string, byKoffi: boolean): unknown {
    if (value === undefined) {
      return null;
    }
    if (plan.reached.element === DescribedKind.Value) {
      const block = this.arena.allocate(plan.stride);
      writeValue(this.arena, block, 0, value);
      return block;
    }
    return byKoffi ? this.image(plan.target!, value, where, true) : this.#arenaStruct(plan.target!, value, where);
  }

  #arenaStruct(type: LaidOutType, value: unknown, where: string): object {
    const block = this.arena.allocate(type.described.size);
    koffi.encode(block, 0, type.arenaType, this.image(type, value, where, false));
    return block;
  }

  #array(plan: ReachPlan, value: unknown, where: string, byKoffi: boolean): Written {
    const items = arrayOf(value, where);
    if (items.length === 0) {
      return nothingWritten;
    }
    const { element } = plan.reached;
    if (element === DescribedKind.Value) {
      const block = this.arena.allocate(items.length * plan.stride);
      items.forEach((item, index) => {
        if (item === undefined) {
          throw new TypeError(`${where}[${index}] is a value in an array, where NONE may not stand.`);
        }
        writeValue(this.arena, block, index * plan.stride, item);
      });
      return { value: block, count: items.length };
    }
    if (element === DescribedKind.Struct) {
      const images = items.map((item, index) => this.image(plan.target!, item, `${where}[${index}]`, byKoffi));
      return { value: byKoffi ? images : this.#arenaElements(plan, images), count: items.length };
    }
    const scalars = items.map((item, index) => scalarForC(element, item, `${where}[${index}]`));
    return { value: byKoffi ? scalars : this.#arenaElements(plan, scalars), count: items.length };
  }

  #arenaElements(plan: ReachPlan, elements: readonly unknown[]): object {
    const type = plan.reached.element === DescribedKind.Struct ? plan.target!.arenaType : scalarTypes[plan.reached.element]!;
    const block = this.arena.allocate(elements.length * plan.stride);
    elements.forEach((element, index) => koffi.encode(block, index * plan.stride, type, element));
    return block;
  }

  /**
   * Reads a `type` at `offset` of `base`, whose bytes `view` covers from `base` on, as a plain object, leaving out a
   * NULL pointer, a NULL handle and a value of kind NONE; a handle it holds is wrapped, `handles` collecting every one
   * wrapped.
   */
  readStruct(base: object, view: DataView, offset: number, type: LaidOutType, handles: DescribedHandle[]): Record<string, unknown> {
    const object: Record<string, unknown> = {};
    for (const plan of type.plans) {
      const value = this.#readMember(base, view, offset, plan, handles);
      if (value !== undefined) {
        object[plan.member.name] = value;
      }
    }
    return object;
  }

  #readMember(base: object, view: DataView, offset: number, plan: MemberPlan, handles: DescribedHandle[]): unknown {
    const { member } = plan;
    const at = offset + member.offset;
    if (member.kind in scalarTypes) {
      return scalarAt(view, at, member.kind);
    }
    switch (member.kind) {
      case DescribedKind.Struct:
        return this.readStruct(base, view, at, plan.target!, handles);
      case DescribedKind.Value:
        return view.getUint32(at + valueKindOffset, littleEndian) === 0 ? undefined : readValue(base, at);
      default: {
        const count = plan.count === null ? 0 : sizeAt(view, offset + plan.count.offset);
        return this.readReached(plan, base, at, isNullAt(view, at), count, handles);
      }
    }
  }

  /**
   * Reads what the pointer stored at `at` of `holder` reaches; undefined for a NULL pointer or handle, an empty array
   * for a NULL counted one.
   */
  readReached(plan: ReachPlan, holder: object, at: number, isNull: boolean, count: number, handles: DescribedHandle[]): unknown {
    const { kind, element, release, type } = plan.reached;
    switch (kind) {
      case DescribedKind.Text:
        return isNull ? null : (koffi.decode(holder, at, "const char *") as string);
      case DescribedKind.Texts:
        return isNull || count === 0 ? [] : readTexts(pointerAt(holder, at), count);
      case DescribedKind.Bytes:
        return isNull || count === 0 ? new Uint8Array(0) : (koffi.decode(pointerAt(holder, at), 0, "uint8_t", count) as Uint8Array).slice();
      case DescribedKind.Pointer:
        return isNull ? undefined : this.#readElements(plan, pointerAt(holder, at), 1, handles)[0];
      case DescribedKind.Array:
        return isNull || count === 0 ? [] : this.#readElements(plan, pointerAt(holder, at), count, handles);
      case DescribedKind.Handle:
        return isNull ? undefined : this.#hold(pointerAt(holder, at), type!, release, handles);
      default:
        return undefined;
    }
  }

  #readElements(plan: ReachPlan, pointer: object, count: number, handles: DescribedHandle[]): unknown[] {
    const { element } = plan.reached;
    if (element === DescribedKind.Struct) {
      const view = viewOf(pointer, count * plan.stride);
      return Array.from({ length: count }, (_, index) => this.readStruct(pointer, view, index * plan.stride, plan.target!, handles));
    }
    if (element === DescribedKind.Value) {
      return Array.from({ length: count }, (_, index) => readValue(pointer, index * plan.stride));
    }
    return Array.from(koffi.decode(pointer, 0, scalarTypes[element]!, count) as ArrayLike<number | bigint>, (raw) => scalarFromC(element, raw));
  }

  #hold(pointer: object, type: string, release: string | null, handles: DescribedHandle[]): DescribedHandle {
    const handle = this.context.holdings.hold(pointer, type, (held) => this.context.freeHandle(release, held));
    handles.push(handle);
    return handle;
  }
}

function pointerAt(holder: object, at: number): object {
  return koffi.decode(holder, at, "void *") as object;
}

function readTexts(pointer: object, count: number): (string | null)[] {
  return Array.from({ length: count }, (_, index) => koffi.decode(pointer, index * pointerSize, "const char *") as string | null);
}

function arrayOf(value: unknown, where: string): readonly unknown[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError(`${where} is counted, written as an array.`);
  }
  return value;
}

/** @throws TypeError for anything but a string, null or undefined, and EmbeddedNulError for a string holding a NUL. */
function checkedText(value: unknown, where: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new TypeError(`${where} is a text, written as a string or null.`);
  }
  if (value.includes("\u0000")) {
    throw new EmbeddedNulError(value);
  }
  return value;
}
