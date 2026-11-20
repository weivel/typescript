import koffi from "koffi";
import { descriptionStructs, type DescriptionStructName } from "./layout.js";

type DecodedFields = Record<string, unknown>;

export interface DescribedMember {
  readonly name: string;
  readonly offset: number;
  readonly size: number;
  readonly kind: number;
  readonly element: number;
  readonly type: string | null;
  readonly count: string | null;
  readonly release: string | null;
}

export interface DescribedType {
  readonly name: string;
  readonly size: number;
  readonly firstShape: number;
  readonly members: readonly DescribedMember[];
}

export interface DescribedEnum {
  readonly name: string;
  readonly entries: readonly { readonly name: string; readonly number: number }[];
}

export interface DescribedParameter {
  readonly name: string;
  readonly kind: number;
  readonly role: number;
  readonly element: number;
  readonly type: string | null;
  readonly count: string | null;
  readonly release: string | null;
}

export interface DescribedOperation {
  readonly name: string;
  readonly offset: number;
  readonly returns: number;
  readonly parameters: readonly DescribedParameter[];
}

/** A description as JavaScript values, read once at the load from the struct the library answered. */
export interface Description {
  readonly definition: string;
  readonly types: readonly DescribedType[];
  readonly enums: readonly DescribedEnum[];
  readonly operations: readonly DescribedOperation[];
}

function elementsOf(items: unknown, count: unknown, name: DescriptionStructName): DecodedFields[] {
  if (items === null) {
    return [];
  }
  const type = descriptionStructs[name];
  const stride = koffi.sizeof(type);
  return Array.from({ length: Number(count) }, (_, index) => koffi.decode(items as object, index * stride, type) as DecodedFields);
}

function readMember(fields: DecodedFields): DescribedMember {
  return {
    name: fields.name as string,
    offset: Number(fields.offset),
    size: Number(fields.size),
    kind: fields.kind as number,
    element: fields.element as number,
    type: fields.type as string | null,
    count: fields.count as string | null,
    release: fields.release as string | null,
  };
}

function readType(fields: DecodedFields): DescribedType {
  return {
    name: fields.name as string,
    size: Number(fields.size),
    firstShape: Number(fields.first_shape),
    members: elementsOf(fields.members, fields.member_count, "weivel_standard_described_member").map(readMember),
  };
}

function readEnum(fields: DecodedFields): DescribedEnum {
  return {
    name: fields.name as string,
    entries: elementsOf(fields.entries, fields.entry_count, "weivel_standard_described_enum_entry").map((entry) => ({
      name: entry.name as string,
      number: entry.number as number,
    })),
  };
}

function readParameter(fields: DecodedFields): DescribedParameter {
  return {
    name: fields.name as string,
    kind: fields.kind as number,
    role: fields.role as number,
    element: fields.element as number,
    type: fields.type as string | null,
    count: fields.count as string | null,
    release: fields.release as string | null,
  };
}

function readOperation(fields: DecodedFields): DescribedOperation {
  return {
    name: fields.name as string,
    offset: Number(fields.offset),
    returns: fields.returns as number,
    parameters: elementsOf(fields.parameters, fields.parameter_count, "weivel_standard_described_parameter").map(readParameter),
  };
}

/**
 * Reads a description the standard's check has passed, so every array it names is as long as its count says and
 * every name it requires is set.
 */
export function readDescription(pointer: object): Description {
  const fields = koffi.decode(pointer, descriptionStructs.weivel_standard_description) as DecodedFields;
  return {
    definition: fields.definition as string,
    types: elementsOf(fields.types, fields.type_count, "weivel_standard_described_type").map(readType),
    enums: elementsOf(fields.enums, fields.enum_count, "weivel_standard_described_enum").map(readEnum),
    operations: elementsOf(fields.operations, fields.operation_count, "weivel_standard_described_operation").map(readOperation),
  };
}
