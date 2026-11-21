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

/** The value 1 is retired and never reused. */
export const FunctionKind = {
  Bytes: 2,
  Definition: 3,
} as const;
export type FunctionKind = ValueOf<typeof FunctionKind> | number;

export const ContextFact = {
  Environment: 1,
  Home: 2,
  Arguments: 4,
} as const;
export type ContextFact = ValueOf<typeof ContextFact>;

/** A weivel_standard_host_mode: what a host program's run does. */
export const HostMode = {
  Serve: 1,
  Action: 2,
} as const;
export type HostMode = ValueOf<typeof HostMode> | number;

/** A weivel_standard_host_plugin_state: what became of one plugin a host program's plan named. */
export const HostPluginState = {
  Activated: 1,
  Refused: 2,
  Failed: 3,
} as const;
export type HostPluginState = ValueOf<typeof HostPluginState>;

/** WEIVEL_STANDARD_SHA256_BYTES and WEIVEL_STANDARD_SHA256_HEX_LENGTH. */
export const SHA256_BYTES = 32;
export const SHA256_HEX_LENGTH = 64;
