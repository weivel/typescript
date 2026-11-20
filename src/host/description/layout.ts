import koffi from "koffi";

type KoffiType = ReturnType<typeof koffi.opaque>;

const text = "const char *";
const count = "size_t";
const pointer = "void *";

/** @remarks Anonymous, as the core's and the standard's declarations are, so a module evaluated twice is not refused. */
function structOf(fields: Record<string, string | KoffiType>): KoffiType {
  return koffi.struct(fields);
}

const weivel_standard_described_member = structOf({
  name: text,
  offset: count,
  size: count,
  kind: "uint32_t",
  element: "uint32_t",
  type: text,
  count: text,
  release: text,
});
const weivel_standard_described_type = structOf({
  name: text,
  size: count,
  first_shape: count,
  members: pointer,
  member_count: count,
});
const weivel_standard_described_enum_entry = structOf({ name: text, number: "uint32_t" });
const weivel_standard_described_enum = structOf({ name: text, entries: pointer, entry_count: count });
const weivel_standard_described_parameter = structOf({
  name: text,
  kind: "uint32_t",
  role: "uint32_t",
  element: "uint32_t",
  type: text,
  count: text,
  release: text,
});
const weivel_standard_described_operation = structOf({
  name: text,
  offset: count,
  returns: "uint32_t",
  parameters: pointer,
  parameter_count: count,
});
const weivel_standard_description = structOf({
  size: "uint32_t",
  definition: text,
  types: pointer,
  type_count: count,
  enums: pointer,
  enum_count: count,
  operations: pointer,
  operation_count: count,
  blocking: pointer,
  blocking_count: count,
  definitions: pointer,
  definition_count: count,
});

/**
 * Every struct `weivel/description.h` declares, laid out field for field as the header lays it out: the one layout
 * the binding writes by hand, since every other struct a definition reaches is laid out from its description.
 */
export const descriptionStructs = {
  weivel_standard_described_member,
  weivel_standard_described_type,
  weivel_standard_described_enum_entry,
  weivel_standard_described_enum,
  weivel_standard_described_parameter,
  weivel_standard_described_operation,
  weivel_standard_description,
} as const;

export type DescriptionStructName = keyof typeof descriptionStructs;

/** weivel_standard_described_kind. */
export const DescribedKind = {
  None: 0,
  U32: 1,
  U64: 2,
  I64: 3,
  F64: 4,
  Size: 5,
  Text: 6,
  Texts: 7,
  Bytes: 8,
  Struct: 9,
  Pointer: 10,
  Array: 11,
  Value: 12,
  Handle: 13,
  Context: 14,
  Storage: 15,
  Definition: 16,
} as const;

/** The highest kind this binding knows; a description naming a later one is refused whole. */
export const lastKnownKind = DescribedKind.Definition;

/** weivel_standard_described_role. */
export const DescribedRole = { None: 0, Input: 1, Answer: 2, Refusal: 3 } as const;

/** weivel_standard_described_return. */
export const DescribedReturn = { None: 0, Status: 1, Nothing: 2 } as const;
