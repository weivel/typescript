import koffi from "koffi";
import type { CallArena } from "./arena.js";
import type { DescribedHandle, HandleHoldings } from "./handles.js";
import { DescribedKind } from "./layout.js";
import { isLeadingSize, type DescribedLayouts, type LaidOutType } from "./layouts.js";
import type { DescribedMember } from "./reader.js";
import { isScalarKind, scalarForC, scalarFromC, scalarTypes } from "./scalars.js";
import { readValue, valueNodeSize, writeValue } from "./values.js";

/** Frees a handle of the type it is named for, through the release the description names. */
export type HandleRelease = (release: string | null, pointer: object) => void;

/** What one call reaches while it writes and reads structs: the layouts, the arena, and the library's handles. */
export interface StructContext {
  readonly layouts: DescribedLayouts;
  readonly holdings: HandleHoldings;
  readonly freeHandle: HandleRelease;
}

const pointerSize = koffi.sizeof("void *");

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

/** Writes and reads the structs of one call, by the layouts its definition was bound with. */
export class StructWriter {
  constructor(
    readonly context: StructContext,
    readonly arena: CallArena,
  ) {}

  /** A block holding `object` as a `type`, its leading size set: an input pointed at, or an empty answer for undefined. */
  allocateStruct(type: LaidOutType, object: unknown, where: string): object {
    const block = this.arena.allocate(type.described.size);
    this.writeStruct(block, 0, type, object, where);
    return block;
  }

  /**
   * Writes `object` as a `type` at `offset` of `base`, a member it leaves out at its zero.
   *
   * @throws TypeError for anything but a plain object, a member the type does not let a caller write, or a value its
   * member's kind does not hold.
   */
  writeStruct(base: object, offset: number, type: LaidOutType, object: unknown, where: string): void {
    for (const member of type.described.members) {
      if (isLeadingSize(member)) {
        koffi.encode(base, offset, "uint32_t", type.described.size);
      }
    }
    if (object === undefined) {
      return;
    }
    if (!isPlainObject(object)) {
      throw new TypeError(`${where} is a ${type.described.name}, written as a plain object.`);
    }
    refuseUnknownNames(object, type.visible.map((member) => member.name), where);
    for (const member of type.visible) {
      this.#writeMember(base, offset, type, member, object[member.name], `${where}.${member.name}`);
    }
  }

  #writeMember(base: object, offset: number, type: LaidOutType, member: DescribedMember, value: unknown, where: string): void {
    const at = offset + member.offset;
    if (isScalarKind(member.kind)) {
      koffi.encode(base, at, scalarTypes[member.kind]!, scalarForC(member.kind, value, where));
      return;
    }
    switch (member.kind) {
      case DescribedKind.Struct:
        this.writeStruct(base, at, this.context.layouts.type(member.type), value, where);
        return;
      case DescribedKind.Value:
        writeValue(this.arena, base, at, value);
        return;
      default: {
        const written = this.writePointed(member.kind, member.element, member.type, value, where);
        koffi.encode(base, at, "void *", written.pointer);
        if (member.count !== null) {
          koffi.encode(base, offset + type.members.get(member.count)!.offset, "size_t", written.count);
        }
      }
    }
  }

  /**
   * Writes what a pointer-sized member or parameter of `kind` points at, answering the pointer and, for a counted
   * kind, how many it points at; a left-out value is NULL with a count of 0.
   */
  writePointed(kind: number, element: number, type: string | null, value: unknown, where: string): { pointer: object | null; count: number } {
    switch (kind) {
      case DescribedKind.Text:
        return { pointer: this.#text(value, where), count: 0 };
      case DescribedKind.Texts:
        return this.#texts(value, where);
      case DescribedKind.Bytes:
        return this.#bytes(value, where);
      case DescribedKind.Pointer:
        return { pointer: this.#pointedElement(element, type, value, where), count: 0 };
      case DescribedKind.Array:
        return this.#array(element, type, value, where);
      case DescribedKind.Handle:
        return { pointer: value === undefined || value === null ? null : this.context.holdings.pointerOf(value, type!, where), count: 0 };
      default:
        if (value !== undefined) {
          throw new TypeError(`${where} is the provider's own, and a caller writes nothing there.`);
        }
        return { pointer: null, count: 0 };
    }
  }

  #text(value: unknown, where: string): object | null {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== "string") {
      throw new TypeError(`${where} is a text, written as a string or null.`);
    }
    return this.arena.text(value);
  }

  #texts(value: unknown, where: string): { pointer: object | null; count: number } {
    const texts = this.#arrayOf(value, where);
    if (texts.length === 0) {
      return { pointer: null, count: 0 };
    }
    const block = this.arena.allocate(texts.length * pointerSize);
    texts.forEach((text, index) => koffi.encode(block, index * pointerSize, "void *", this.#text(text, `${where}[${index}]`)));
    return { pointer: block, count: texts.length };
  }

  #bytes(value: unknown, where: string): { pointer: object | null; count: number } {
    if (value === undefined) {
      return { pointer: null, count: 0 };
    }
    if (!(value instanceof Uint8Array)) {
      throw new TypeError(`${where} is bytes, written as a Uint8Array.`);
    }
    return { pointer: this.arena.bytes(value), count: value.length };
  }

  #pointedElement(element: number, type: string | null, value: unknown, where: string): object | null {
    if (value === undefined) {
      return null;
    }
    if (element === DescribedKind.Value) {
      const block = this.arena.allocate(valueNodeSize);
      writeValue(this.arena, block, 0, value);
      return block;
    }
    return this.allocateStruct(this.context.layouts.type(type), value, where);
  }

  #array(element: number, type: string | null, value: unknown, where: string): { pointer: object | null; count: number } {
    const items = this.#arrayOf(value, where);
    if (items.length === 0) {
      return { pointer: null, count: 0 };
    }
    const stride = this.context.layouts.elementSize(element, type);
    const block = this.arena.allocate(items.length * stride);
    items.forEach((item, index) => this.#writeElement(block, index * stride, element, type, item, `${where}[${index}]`));
    return { pointer: block, count: items.length };
  }

  #arrayOf(value: unknown, where: string): readonly unknown[] {
    if (value === undefined) {
      return [];
    }
    if (!Array.isArray(value)) {
      throw new TypeError(`${where} is counted, written as an array.`);
    }
    return value;
  }

  #writeElement(block: object, at: number, element: number, type: string | null, item: unknown, where: string): void {
    if (element === DescribedKind.Struct) {
      this.writeStruct(block, at, this.context.layouts.type(type), item, where);
    } else if (element === DescribedKind.Value) {
      if (item === undefined) {
        throw new TypeError(`${where} is a value in an array, where NONE may not stand.`);
      }
      writeValue(this.arena, block, at, item);
    } else {
      koffi.encode(block, at, scalarTypes[element]!, scalarForC(element, item, where));
    }
  }

  /**
   * Reads a `type` at `offset` of `base` as a plain object, leaving out a NULL pointer, a NULL handle and a value of
   * kind NONE; a handle it holds is wrapped, `handles` collecting every one wrapped.
   */
  readStruct(base: object, offset: number, type: LaidOutType, handles: DescribedHandle[]): Record<string, unknown> {
    const object: Record<string, unknown> = {};
    for (const member of type.visible) {
      const value = this.#readMember(base, offset, type, member, handles);
      if (value !== undefined) {
        object[member.name] = value;
      }
    }
    return object;
  }

  #readMember(base: object, offset: number, type: LaidOutType, member: DescribedMember, handles: DescribedHandle[]): unknown {
    const at = offset + member.offset;
    if (isScalarKind(member.kind)) {
      return scalarFromC(member.kind, koffi.decode(base, at, scalarTypes[member.kind]!));
    }
    switch (member.kind) {
      case DescribedKind.Struct:
        return this.readStruct(base, at, this.context.layouts.type(member.type), handles);
      case DescribedKind.Value:
        return readValue(base, at);
      default: {
        const count = member.count === null ? 0 : Number(koffi.decode(base, offset + type.members.get(member.count)!.offset, "size_t"));
        return this.readPointed(member.kind, member.element, member.type, member.release, koffi.decode(base, at, "void *") as object | null, count, handles);
      }
    }
  }

  /** Reads what a pointer of `kind` points at; undefined for a NULL pointer or handle, an empty array for a NULL counted one. */
  readPointed(kind: number, element: number, type: string | null, release: string | null, pointer: object | null, count: number, handles: DescribedHandle[]): unknown {
    switch (kind) {
      case DescribedKind.Text:
        return pointer === null ? null : (koffi.decode(pointer, "char", -1) as string);
      case DescribedKind.Texts:
        return Array.from({ length: pointer === null ? 0 : count }, (_, index) => koffi.decode(pointer!, index * pointerSize, "const char *") as string | null);
      case DescribedKind.Bytes:
        return pointer === null || count === 0 ? new Uint8Array(0) : (koffi.decode(pointer, 0, "uint8_t", count) as Uint8Array).slice();
      case DescribedKind.Pointer:
        return pointer === null ? undefined : this.#readElement(pointer, 0, element, type, handles);
      case DescribedKind.Array: {
        const stride = this.context.layouts.elementSize(element, type);
        return Array.from({ length: pointer === null ? 0 : count }, (_, index) => this.#readElement(pointer!, index * stride, element, type, handles));
      }
      case DescribedKind.Handle:
        return pointer === null ? undefined : this.#hold(pointer, type!, release, handles);
      default:
        return undefined;
    }
  }

  #hold(pointer: object, type: string, release: string | null, handles: DescribedHandle[]): DescribedHandle {
    const handle = this.context.holdings.hold(pointer, type, (held) => this.context.freeHandle(release, held));
    handles.push(handle);
    return handle;
  }

  #readElement(block: object, at: number, element: number, type: string | null, handles: DescribedHandle[]): unknown {
    if (element === DescribedKind.Struct) {
      return this.readStruct(block, at, this.context.layouts.type(type), handles);
    }
    if (element === DescribedKind.Value) {
      return readValue(block, at);
    }
    return scalarFromC(element, koffi.decode(block, at, scalarTypes[element]!));
  }
}
