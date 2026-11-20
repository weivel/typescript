import koffi from "koffi";
import { standardStructs } from "../../standard/declarations.js";
import type { CallArena } from "./arena.js";

/**
 * A value tree as JavaScript holds it: null, a boolean, a finite number, a string, an array or a plain object of
 * them. `undefined` stands for NONE, which only a tree's root may be.
 */
export type NativeValue = null | boolean | number | string | readonly NativeValue[] | { readonly [key: string]: NativeValue };

const ValueKind = { None: 0, Null: 1, Boolean: 2, Number: 3, Text: 4, List: 5, Record: 6 } as const;

/** WEIVEL_STANDARD_VALUE_DEPTH_LIMIT. */
const depthLimit = 1000;

const node = standardStructs.weivel_standard_value;
const entry = standardStructs.weivel_standard_entry;
export const valueNodeSize = koffi.sizeof(node);
export const valueTreeSize = koffi.sizeof(standardStructs.weivel_standard_value_tree);
export const valueTreeRootOffset = koffi.offsetof(standardStructs.weivel_standard_value_tree, "root");
const entrySize = koffi.sizeof(entry);
const field = {
  kind: koffi.offsetof(node, "kind"),
  boolean: koffi.offsetof(node, "boolean"),
  number: koffi.offsetof(node, "number"),
  text: koffi.offsetof(node, "text"),
  length: koffi.offsetof(node, "length"),
  items: koffi.offsetof(node, "items"),
  entries: koffi.offsetof(node, "entries"),
  count: koffi.offsetof(node, "count"),
};
const entryField = {
  key: koffi.offsetof(entry, "key"),
  keyLength: koffi.offsetof(entry, "key_length"),
  value: koffi.offsetof(entry, "value"),
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** A text's UTF-8 bytes and their NUL-terminated copy. @throws EmbeddedNulError for a text holding a NUL. */
function writeText(arena: CallArena, text: string): { pointer: object | null; length: number } {
  return { pointer: arena.text(text), length: encoder.encode(text).length };
}

/**
 * Writes `value` as one weivel_standard_value at `offset` of `base`, every node below it in the arena.
 *
 * @throws TypeError for a value no node holds: undefined below the root, a number that is not finite, a bigint, or
 * any object but an array or a plain one; and for a tree deeper than the standard's limit.
 */
export function writeValue(arena: CallArena, base: object, offset: number, value: unknown, depth = 0): void {
  if (depth > depthLimit) {
    throw new TypeError(`A value tree nests deeper than ${depthLimit} below its root.`);
  }
  if (value === undefined) {
    if (depth > 0) {
      throw new TypeError("A value tree holds undefined below its root, where NONE may not stand.");
    }
    return;
  }
  if (value === null) {
    koffi.encode(base, offset + field.kind, "uint32_t", ValueKind.Null);
  } else if (typeof value === "boolean") {
    koffi.encode(base, offset + field.kind, "uint32_t", ValueKind.Boolean);
    koffi.encode(base, offset + field.boolean, "uint32_t", value ? 1 : 0);
  } else if (typeof value === "number") {
    writeNumber(base, offset, value);
  } else if (typeof value === "string") {
    const text = writeText(arena, value);
    koffi.encode(base, offset + field.kind, "uint32_t", ValueKind.Text);
    koffi.encode(base, offset + field.text, "void *", text.pointer);
    koffi.encode(base, offset + field.length, "size_t", text.length);
  } else if (Array.isArray(value)) {
    writeList(arena, base, offset, value, depth);
  } else if (isPlainObject(value)) {
    writeRecord(arena, base, offset, value, depth);
  } else {
    throw new TypeError(`A value tree holds null, booleans, numbers, strings, arrays and plain objects, not ${typeof value}.`);
  }
}

function writeNumber(base: object, offset: number, value: number): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`A value tree's number is finite, and ${value} is not.`);
  }
  koffi.encode(base, offset + field.kind, "uint32_t", ValueKind.Number);
  koffi.encode(base, offset + field.number, "double", value);
}

function writeList(arena: CallArena, base: object, offset: number, items: readonly unknown[], depth: number): void {
  const block = items.length === 0 ? null : arena.allocate(items.length * valueNodeSize);
  items.forEach((item, index) => writeValue(arena, block!, index * valueNodeSize, item, depth + 1));
  koffi.encode(base, offset + field.kind, "uint32_t", ValueKind.List);
  koffi.encode(base, offset + field.items, "void *", block);
  koffi.encode(base, offset + field.count, "size_t", items.length);
}

function writeRecord(arena: CallArena, base: object, offset: number, record: Record<string, unknown>, depth: number): void {
  const entries = Object.entries(record);
  const block = entries.length === 0 ? null : arena.allocate(entries.length * entrySize);
  entries.forEach(([key, value], index) => {
    const at = index * entrySize;
    const text = writeText(arena, key);
    koffi.encode(block!, at + entryField.key, "void *", text.pointer);
    koffi.encode(block!, at + entryField.keyLength, "size_t", text.length);
    writeValue(arena, block!, at + entryField.value, value, depth + 1);
  });
  koffi.encode(base, offset + field.kind, "uint32_t", ValueKind.Record);
  koffi.encode(base, offset + field.entries, "void *", block);
  koffi.encode(base, offset + field.count, "size_t", entries.length);
}

function readTextOf(base: object, textOffset: number, lengthOffset: number): string {
  const pointer = koffi.decode(base, textOffset, "void *") as object | null;
  const length = Number(koffi.decode(base, lengthOffset, "size_t"));
  if (pointer === null || length === 0) {
    return "";
  }
  return decoder.decode(koffi.decode(pointer, 0, "uint8_t", length) as Uint8Array);
}

/**
 * Reads the weivel_standard_value at `offset` of `base` as a NativeValue, or undefined for NONE at the root.
 *
 * @throws Error for a node a provider may not answer: NONE below the root, a kind this binding does not know, or a
 * tree deeper than the standard's limit.
 */
export function readValue(base: object, offset: number, depth = 0): NativeValue | undefined {
  if (depth > depthLimit) {
    throw new Error(`The provider answered a value tree nested deeper than ${depthLimit} below its root.`);
  }
  const kind = koffi.decode(base, offset + field.kind, "uint32_t") as number;
  switch (kind) {
    case ValueKind.None:
      if (depth > 0) {
        throw new Error("The provider answered a value tree holding NONE below its root.");
      }
      return undefined;
    case ValueKind.Null:
      return null;
    case ValueKind.Boolean:
      return (koffi.decode(base, offset + field.boolean, "uint32_t") as number) !== 0;
    case ValueKind.Number:
      return koffi.decode(base, offset + field.number, "double") as number;
    case ValueKind.Text:
      return readTextOf(base, offset + field.text, offset + field.length);
    case ValueKind.List:
      return readList(base, offset, depth);
    case ValueKind.Record:
      return readRecord(base, offset, depth);
    default:
      throw new Error(`The provider answered a value of kind ${kind}, which this binding does not know.`);
  }
}

function countAndBlock(base: object, offset: number, blockField: number): { block: object | null; count: number } {
  return {
    block: koffi.decode(base, offset + blockField, "void *") as object | null,
    count: Number(koffi.decode(base, offset + field.count, "size_t")),
  };
}

function readList(base: object, offset: number, depth: number): NativeValue[] {
  const { block, count } = countAndBlock(base, offset, field.items);
  if (block === null) {
    return [];
  }
  return Array.from({ length: count }, (_, index) => readValue(block, index * valueNodeSize, depth + 1)!);
}

function readRecord(base: object, offset: number, depth: number): Record<string, NativeValue> {
  const { block, count } = countAndBlock(base, offset, field.entries);
  const record: Record<string, NativeValue> = {};
  for (let index = 0; block !== null && index < count; index += 1) {
    const at = index * entrySize;
    const key = readTextOf(block, at + entryField.key, at + entryField.keyLength);
    Object.defineProperty(record, key, { value: readValue(block, at + entryField.value, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return record;
}
