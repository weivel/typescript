type ValueOf<Table> = Table[keyof Table];

export const Status = {
  Ok: 0,
  None: 1,
  Malformed: 2,
  Refused: 3,
  OutOfMemory: 4,
} as const;
export type Status = ValueOf<typeof Status>;

export const RefusalCode = {
  None: 0,
  MalformedCall: 1,
  StaleHandle: 2,
  MalformedManifest: 3,
  Incompatible: 4,
  NameTaken: 5,
  UnmetNeed: 6,
  RepeatedPlugin: 7,
  PluginState: 8,
  IdentityTaken: 9,
  OutsideNamespace: 10,
  ServiceTaken: 11,
  Undeclared: 12,
  WrongProvider: 13,
  Stopped: 14,
  TimedOut: 15,
  UnmetConstraint: 16,
  NotServed: 17,
  ActivationMismatch: 18,
  ProvidedTwice: 19,
} as const;
/** A weivel_refusal_code; a code a newer core adds arrives as its number. */
export type RefusalCode = ValueOf<typeof RefusalCode> | number;

export const LogLevel = {
  Default: 0,
  Debug: 1,
  Info: 2,
  Warning: 3,
  Error: 4,
} as const;
export type LogLevel = ValueOf<typeof LogLevel> | number;

export const EventKind = {
  None: 0,
  Log: 1,
  Refusal: 2,
  WantSettled: 3,
  Watch: 4,
  Revoked: 5,
  ReachRefused: 6,
  CapacityWanted: 7,
  Capability: 8,
  Deadline: 9,
} as const;
export type EventKind = ValueOf<typeof EventKind>;

export const Change = {
  Registered: 1,
  Unregistered: 2,
} as const;
export type Change = ValueOf<typeof Change> | number;

export const ReachKind = {
  Service: 1,
  Capability: 2,
} as const;
export type ReachKind = ValueOf<typeof ReachKind> | number;

export const CapacityQuestion = {
  Attributes: 1,
  Serve: 2,
} as const;
export type CapacityQuestion = ValueOf<typeof CapacityQuestion> | number;

export const CapabilityChange = {
  Provided: 1,
  Withdrawn: 2,
} as const;
export type CapabilityChange = ValueOf<typeof CapabilityChange> | number;

export const Choice = {
  Default: 0,
  No: 1,
  Yes: 2,
} as const;
export type Choice = ValueOf<typeof Choice>;

export const Bound = {
  Lower: 1,
  Upper: 2,
} as const;
export type Bound = ValueOf<typeof Bound>;

export const Axis = {
  None: 0,
  Application: 1,
  Api: 2,
} as const;
export type Axis = ValueOf<typeof Axis> | number;

export const EdgeSource = {
  Capabilities: 1,
  Services: 2,
} as const;
export type EdgeSource = ValueOf<typeof EdgeSource>;

export const HandleCondition = {
  Waiting: 1,
  Settled: 2,
  Withdrawn: 3,
  Watching: 4,
  Stopped: 5,
} as const;
export type HandleCondition = ValueOf<typeof HandleCondition> | number;

export const PluginStatus = {
  Registered: 1,
  Active: 2,
  Quarantined: 3,
  Released: 4,
} as const;
export type PluginStatus = ValueOf<typeof PluginStatus> | number;

/** WEIVEL_HOST: the reserved handle that stands for the host itself. */
export const HOST: bigint = 0xffff_ffff_ffff_ffffn;

/** WEIVEL_API_VERSION of the header these declarations follow. */
export const API_VERSION = 2;

/** WEIVEL_CORE_MAXIMUM_INITIAL_EVENT_CAPACITY. */
export const MAXIMUM_INITIAL_EVENT_CAPACITY = 65536;
