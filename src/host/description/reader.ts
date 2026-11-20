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
  /** The operations that may block, in the description's order; none for a description whose `size` ends before them. */
  readonly blocking: readonly string[];
  /** The description of every definition a DEFINITION member or parameter names, each by its own `definition`. */
  readonly definitions: readonly Description[];
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

const descriptionType = descriptionStructs.weivel_standard_description;
const descriptionMembers = koffi.introspect(descriptionType).members!;
const pointerSize = koffi.sizeof("void *");

/** The field `name` of the description at `pointer`, or undefined when its answered `size` ends before the field does. */
function fieldWithin(pointer: object, answeredSize: number, name: string): unknown {
  const member = descriptionMembers[name]!;
  return member.offset + koffi.sizeof(member.type) > answeredSize ? undefined : koffi.decode(pointer, member.offset, member.type);
}

/** The `count` pointers, each read as `type`, of the array at `items`; none for an array the description does not reach. */
function arrayOfPointers<Item>(items: unknown, count: unknown, type: string): Item[] {
  if (items === undefined || items === null || count === undefined) {
    return [];
  }
  return Array.from({ length: Number(count) }, (_, index) => koffi.decode(items as object, index * pointerSize, type) as Item);
}

/**
 * Reads a description the standard's check has passed, so every array it names is as long as its count says, every
 * name it requires is set, and its nested descriptions hold no cycle. A field past the `size` it answered is read as
 * none, so a description of an earlier shape reads as blocking nothing and nesting nothing.
 */
export function readDescription(pointer: object): Description {
  const answeredSize = koffi.decode(pointer, "uint32_t") as number;
  const field = (name: string): unknown => fieldWithin(pointer, answeredSize, name);
  return {
    definition: field("definition") as string,
    types: elementsOf(field("types"), field("type_count"), "weivel_standard_described_type").map(readType),
    enums: elementsOf(field("enums"), field("enum_count"), "weivel_standard_described_enum").map(readEnum),
    operations: elementsOf(field("operations"), field("operation_count"), "weivel_standard_described_operation").map(readOperation),
    blocking: arrayOfPointers<string>(field("blocking"), field("blocking_count"), "const char *"),
    definitions: arrayOfPointers<object>(field("definitions"), field("definition_count"), "void *").map(readDescription),
  };
}
