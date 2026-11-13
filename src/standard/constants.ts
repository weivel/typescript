type ValueOf<Table> = Table[keyof Table];

export const StandardRefusalCode = {
  None: 0,
  MalformedCall: 1,
  MalformedJson: 2,
  WrongType: 3,
  Unrepresentable: 4,
  MissingField: 5,
  InvalidValue: 6,
  Duplicate: 7,
  NotWellKnown: 8,
  ConflictingField: 9,
  Unreadable: 10,
  NotFound: 11,
  NameMismatch: 12,
} as const;
/** A weivel_standard_refusal_code; a code a newer standard appends arrives as its number. */
export type StandardRefusalCode = ValueOf<typeof StandardRefusalCode> | number;

export const IdentityKind = {
  Local: 0,
  Forge: 1,
} as const;
export type IdentityKind = ValueOf<typeof IdentityKind> | number;

export const FunctionKind = {
  Json: 1,
} as const;
export type FunctionKind = ValueOf<typeof FunctionKind> | number;

export const ContextFact = {
  Environment: 1,
  Home: 2,
  Arguments: 4,
} as const;
export type ContextFact = ValueOf<typeof ContextFact>;

/** WEIVEL_STANDARD_SHA256_BYTES and WEIVEL_STANDARD_SHA256_HEX_LENGTH. */
export const SHA256_BYTES = 32;
export const SHA256_HEX_LENGTH = 64;
