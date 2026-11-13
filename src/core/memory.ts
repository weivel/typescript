import koffi from "koffi";
import type { RefusalCode } from "./constants.js";
import { coreStructs, sizeOf, type CoreStructName } from "./declarations.js";
import type { NamedNumber, Refusal } from "./values.js";

/** A pointer into the core's memory, as koffi hands it over; null for NULL. */
export type NativePointer = object | null;

export interface DecodedRefusal {
  code: number;
  detail: string | null;
  fix: string | null;
}

export interface DecodedList {
  items: NativePointer;
  count: number;
}

type DecodedFields = Record<string, unknown>;

const pointerSize = koffi.sizeof("void *");
const handleSize = koffi.sizeof("uint64_t");

/** A 64-bit value koffi decoded, which it answers as a number when it fits one, made a bigint always. */
export function toBigInt(value: unknown): bigint {
  return BigInt(value as number | bigint);
}

/** A struct of `type` in memory koffi owns, zeroed, its leading `size` set to the layer's `sizeof`; freed by koffi.free. */
export function allocateSized(type: ReturnType<typeof koffi.opaque>): object {
  const byteSize = koffi.sizeof(type);
  const pointer = koffi.alloc(type, 1) as object;
  koffi.encode(pointer, 0, "uint8_t", new Array(byteSize).fill(0), byteSize);
  koffi.encode(pointer, 0, "uint32_t", byteSize);
  return pointer;
}

export function decodeStruct(pointer: object, offset: number, name: CoreStructName): DecodedFields {
  return koffi.decode(pointer, offset, coreStructs[name]) as DecodedFields;
}

export function readRefusal(refusal: DecodedRefusal, subject: unknown, hasFix: unknown): Refusal {
  return {
    code: refusal.code as RefusalCode,
    detail: refusal.detail,
    fix: refusal.fix,
    subject: (subject as string | null | undefined) ?? null,
    hasFix: hasFix === 1,
  };
}

export function readStrings(list: DecodedList | undefined): string[] {
  if (list === undefined || list.items === null) {
    return [];
  }
  const items = list.items;
  return Array.from({ length: list.count }, (_, index) => koffi.decode(items, index * pointerSize, "const char *") as string);
}

export function readHandles(items: NativePointer, count: number): bigint[] {
  if (items === null) {
    return [];
  }
  return Array.from({ length: count }, (_, index) => toBigInt(koffi.decode(items, index * handleSize, "uint64_t")));
}

/** Reads an array whose elements never grow, at this layer's own stride. */
export function readFixedElements(items: NativePointer, count: number, name: CoreStructName): DecodedFields[] {
  if (items === null) {
    return [];
  }
  const stride = sizeOf(name);
  return Array.from({ length: count }, (_, index) => decodeStruct(items, index * stride, name));
}

interface Member {
  name: string;
  type: ReturnType<typeof koffi.opaque>;
  offset: number;
  size: number;
}

const membersByStruct = new Map<CoreStructName, Member[]>();

function membersOf(name: CoreStructName): Member[] {
  let members = membersByStruct.get(name);
  if (members === undefined) {
    members = Object.values(koffi.introspect(coreStructs[name]).members ?? {}).map((member) => ({
      ...member,
      size: koffi.sizeof(member.type),
    }));
    membersByStruct.set(name, members);
  }
  return members;
}

/**
 * Reads the fields of one element that `coveredBytes` reaches, leaving the rest out.
 *
 * @remarks An element built by an older core is shorter than this layer's struct, and the bytes past it belong to
 * the next element.
 */
function readCoveredFields(pointer: object, offset: number, name: CoreStructName, coveredBytes: number): DecodedFields {
  const fields: DecodedFields = {};
  for (const member of membersOf(name)) {
    if (member.offset + member.size <= coveredBytes) {
      fields[member.name] = koffi.decode(pointer, offset + member.offset, member.type);
    }
  }
  return fields;
}

/** Reads an array of size-prefixed elements that may grow, stepped by the first element's own `size`. */
export function readGrowingElements(items: NativePointer, count: number, name: CoreStructName): DecodedFields[] {
  if (items === null || count === 0) {
    return [];
  }
  const stride = koffi.decode(items, 0, "uint32_t") as number;
  return Array.from({ length: count }, (_, index) => readCoveredFields(items, index * stride, name, stride));
}

export function readNumbers(list: DecodedList): NamedNumber[] {
  return readGrowingElements(list.items, list.count, "weivel_number").map((number) => ({
    name: number.name as string,
    value: number.value as number,
  }));
}
