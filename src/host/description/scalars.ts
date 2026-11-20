import koffi from "koffi";
import { DescribedKind } from "./layout.js";

/** A number or bigint a described integer is handed as, or an f64's number. */
export type ScalarValue = number | bigint;

const sizeBits = BigInt(koffi.sizeof("size_t") * 8);

interface IntegerRange {
  readonly low: bigint;
  readonly high: bigint;
}

const integerRanges: Readonly<Record<number, IntegerRange>> = {
  [DescribedKind.U32]: { low: 0n, high: 2n ** 32n - 1n },
  [DescribedKind.U64]: { low: 0n, high: 2n ** 64n - 1n },
  [DescribedKind.I64]: { low: -(2n ** 63n), high: 2n ** 63n - 1n },
  [DescribedKind.Size]: { low: 0n, high: 2n ** sizeBits - 1n },
};

/** The C type a scalar kind is, as koffi names it. */
export const scalarTypes: Readonly<Record<number, string>> = {
  [DescribedKind.U32]: "uint32_t",
  [DescribedKind.U64]: "uint64_t",
  [DescribedKind.I64]: "int64_t",
  [DescribedKind.F64]: "double",
  [DescribedKind.Size]: "size_t",
};

export function isScalarKind(kind: number): boolean {
  return kind in scalarTypes;
}

/**
 * `value` as koffi writes the scalar `kind`: an integer kind takes a number that is a safe integer or a bigint, and
 * either must lie in the kind's range; an f64 takes a number. Left out, it is 0.
 *
 * @throws TypeError for a value of another type, a number that is not a safe integer, or one out of range, which koffi
 * would otherwise wrap or round without a word.
 */
export function scalarForC(kind: number, value: unknown, where: string): ScalarValue {
  if (value === undefined) {
    return 0;
  }
  if (kind === DescribedKind.F64) {
    if (typeof value !== "number") {
      throw new TypeError(`${where} is an f64, so it takes a number, not ${typeof value}.`);
    }
    return value;
  }
  const range = integerRanges[kind]!;
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new TypeError(`${where} takes an integer, and ${value} is not one a number holds exactly; pass a bigint.`);
  }
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new TypeError(`${where} takes an integer as a number or a bigint, not ${typeof value}.`);
  }
  const integer = BigInt(value);
  if (integer < range.low || integer > range.high) {
    throw new TypeError(`${where} holds ${range.low} to ${range.high}, and ${integer} lies outside.`);
  }
  return kind === DescribedKind.U32 ? Number(integer) : integer;
}

/** A scalar koffi read, an integer as a number when it is a safe integer and as a bigint beyond. */
export function scalarFromC(kind: number, raw: unknown): ScalarValue {
  if (kind === DescribedKind.F64 || kind === DescribedKind.U32) {
    return raw as number;
  }
  const integer = BigInt(raw as number | bigint);
  return integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer;
}
