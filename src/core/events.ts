import koffi from "koffi";
import { EventKind, type CapabilityChange, type CapacityQuestion, type Change, type LogLevel, type ReachKind } from "./constants.js";
import { offsetOf, type CoreStructName } from "./declarations.js";
import {
  decodeFixedPart,
  decodeStruct,
  readNumbers,
  readRefusal,
  toBigInt,
  type DecodedList,
  type DecodedRefusal,
} from "./memory.js";

export { TEXT_NOT_COPIED } from "./memory.js";
import type { NamedNumber, Refusal } from "./values.js";

/**
 * Present only on an event the layer could not copy whole: every handle, kind, code and number exact, each text the
 * core gave TEXT_NOT_COPIED, and a capacity question's constraints left out.
 */
interface Completeness {
  readonly incomplete?: true;
}

export interface LogEvent extends Completeness {
  readonly kind: "log";
  readonly level: LogLevel;
  readonly text: string | null;
}

export interface RefusalEvent extends Completeness {
  readonly kind: "refusal";
  readonly refusal: Refusal;
}

/**
 * A want settled. `implementation` is 0n when it was rejected, and `refusal` then says why; for a degraded want the
 * refusal's code is NONE and its `subject` names the constraint accepted unmet.
 */
export interface WantSettledEvent extends Completeness {
  readonly kind: "want-settled";
  readonly want: bigint;
  readonly plugin: bigint;
  readonly implementation: bigint;
  readonly refusal: Refusal;
  readonly degraded: boolean;
}

export interface WatchEvent extends Completeness {
  readonly kind: "watch";
  readonly watch: bigint;
  readonly plugin: bigint;
  readonly implementation: bigint;
  readonly change: Change;
}

export interface RevokedEvent extends Completeness {
  readonly kind: "revoked";
  readonly plugin: bigint;
  readonly implementation: bigint;
}

export interface ReachRefusedEvent extends Completeness {
  readonly kind: "reach-refused";
  readonly reachKind: ReachKind;
  readonly plugin: bigint;
  readonly id: string | null;
  readonly refusal: Refusal;
}

export interface CapacityWantedEvent extends Completeness {
  readonly kind: "capacity-wanted";
  readonly want: bigint;
  readonly plugin: bigint;
  readonly registration: bigint;
  readonly request: bigint;
  readonly question: CapacityQuestion;
  readonly constraints: readonly NamedNumber[];
}

export interface CapabilityEvent extends Completeness {
  readonly kind: "capability";
  readonly watch: bigint;
  readonly plugin: bigint;
  readonly implementation: bigint;
  readonly provider: bigint;
  readonly change: CapabilityChange;
}

/** The core's earliest deadline changed: `at` is the deadline to arm, or undefined when nothing waits on time. */
export interface DeadlineEvent extends Completeness {
  readonly kind: "deadline";
  readonly at: number | undefined;
}

/** One drained event as a plain value: nothing in it points into the core. */
export type CoreEvent =
  | LogEvent
  | RefusalEvent
  | WantSettledEvent
  | WatchEvent
  | RevokedEvent
  | ReachRefusedEvent
  | CapacityWantedEvent
  | CapabilityEvent
  | DeadlineEvent;

type DecodedFields = Record<string, unknown>;

/** How a payload is read: wholly, or its fixed part alone for an event that could not be copied whole. */
interface Copying {
  decode(event: object, offset: number, name: CoreStructName): DecodedFields;
  numbers(list: DecodedList): NamedNumber[];
}

const wholly: Copying = { decode: decodeStruct, numbers: readNumbers };
const fixedPartOnly: Copying = { decode: decodeFixedPart, numbers: () => [] };

type PayloadReader = (event: object, payloadOffset: number, copying: Copying) => CoreEvent;

function readLog(event: object, payloadOffset: number, copying: Copying): LogEvent {
  const log = copying.decode(event, payloadOffset, "weivel_log_event");
  return { kind: "log", level: log.level as LogLevel, text: log.text as string | null };
}

function readRefused(event: object, payloadOffset: number, copying: Copying): RefusalEvent {
  const refused = copying.decode(event, payloadOffset, "weivel_refusal_event");
  return { kind: "refusal", refusal: readRefusal(refused.refusal as DecodedRefusal, refused.subject, refused.has_fix) };
}

function readWantSettled(event: object, payloadOffset: number, copying: Copying): WantSettledEvent {
  const want = copying.decode(event, payloadOffset, "weivel_want_event");
  return {
    kind: "want-settled",
    want: toBigInt(want.want),
    plugin: toBigInt(want.plugin),
    implementation: toBigInt(want.implementation),
    refusal: readRefusal(want.refusal as DecodedRefusal, want.subject, want.has_fix),
    degraded: want.degraded === 1,
  };
}

function readWatch(event: object, payloadOffset: number, copying: Copying): WatchEvent {
  const watch = copying.decode(event, payloadOffset, "weivel_watch_event");
  return {
    kind: "watch",
    watch: toBigInt(watch.watch),
    plugin: toBigInt(watch.plugin),
    implementation: toBigInt(watch.implementation),
    change: watch.change as Change,
  };
}

function readRevoked(event: object, payloadOffset: number, copying: Copying): RevokedEvent {
  const revoked = copying.decode(event, payloadOffset, "weivel_revoked_event");
  return { kind: "revoked", plugin: toBigInt(revoked.plugin), implementation: toBigInt(revoked.implementation) };
}

function readReachRefused(event: object, payloadOffset: number, copying: Copying): ReachRefusedEvent {
  const reach = copying.decode(event, payloadOffset, "weivel_reach_refusal");
  return {
    kind: "reach-refused",
    reachKind: reach.kind as ReachKind,
    plugin: toBigInt(reach.plugin),
    id: reach.id as string | null,
    refusal: readRefusal(reach.refusal as DecodedRefusal, reach.subject, reach.has_fix),
  };
}

function readCapacityWanted(event: object, payloadOffset: number, copying: Copying): CapacityWantedEvent {
  const capacity = copying.decode(event, payloadOffset, "weivel_capacity_event");
  return {
    kind: "capacity-wanted",
    want: toBigInt(capacity.want),
    plugin: toBigInt(capacity.plugin),
    registration: toBigInt(capacity.registration),
    request: toBigInt(capacity.request),
    question: capacity.question as CapacityQuestion,
    constraints: copying.numbers(capacity.constraints as DecodedList),
  };
}

function readCapability(event: object, payloadOffset: number, copying: Copying): CapabilityEvent {
  const capability = copying.decode(event, payloadOffset, "weivel_capability_event");
  return {
    kind: "capability",
    watch: toBigInt(capability.watch),
    plugin: toBigInt(capability.plugin),
    implementation: toBigInt(capability.implementation),
    provider: toBigInt(capability.provider),
    change: capability.change as CapabilityChange,
  };
}

function readDeadline(event: object, payloadOffset: number, copying: Copying): DeadlineEvent {
  const deadline = copying.decode(event, payloadOffset, "weivel_deadline_event");
  return { kind: "deadline", at: deadline.set === 1 ? Number(deadline.at) : undefined };
}

const payloadReaders = new Map<number, PayloadReader>([
  [EventKind.Log, readLog],
  [EventKind.Refusal, readRefused],
  [EventKind.WantSettled, readWantSettled],
  [EventKind.Watch, readWatch],
  [EventKind.Revoked, readRevoked],
  [EventKind.ReachRefused, readReachRefused],
  [EventKind.CapacityWanted, readCapacityWanted],
  [EventKind.Capability, readCapability],
  [EventKind.Deadline, readDeadline],
]);

export function eventKindAt(event: object): number {
  return koffi.decode(event, offsetOf("weivel_event", "kind"), "uint32_t") as number;
}

/**
 * Copies the weivel_event at `event` out as a plain value, every string included, so it outlives the event's
 * release. A kind this layer does not know answers undefined.
 */
export function copyEvent(event: object): CoreEvent | undefined {
  const reader = payloadReaders.get(eventKindAt(event));
  return reader?.(event, offsetOf("weivel_event", "data"), wholly);
}

/** Copies the fixed part of an event that could not be copied whole, marked incomplete. */
export function copyIncompleteEvent(event: object): CoreEvent | undefined {
  const reader = payloadReaders.get(eventKindAt(event));
  const copied = reader?.(event, offsetOf("weivel_event", "data"), fixedPartOnly);
  return copied === undefined ? undefined : { ...copied, incomplete: true };
}
