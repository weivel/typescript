import koffi from "koffi";
import { EventKind, type CapabilityChange, type CapacityQuestion, type Change, type LogLevel, type ReachKind } from "./constants.js";
import { offsetOf } from "./declarations.js";
import {
  decodeStruct,
  readNumbers,
  readRefusal,
  toBigInt,
  type DecodedList,
  type DecodedRefusal,
} from "./memory.js";
import type { NamedNumber, Refusal } from "./values.js";

export interface LogEvent {
  readonly kind: "log";
  readonly level: LogLevel;
  readonly text: string | null;
}

export interface RefusalEvent {
  readonly kind: "refusal";
  readonly refusal: Refusal;
}

/**
 * A want settled. `implementation` is 0n when it was rejected, and `refusal` then says why; for a degraded want the
 * refusal's code is NONE and its `subject` names the constraint accepted unmet.
 */
export interface WantSettledEvent {
  readonly kind: "want-settled";
  readonly want: bigint;
  readonly plugin: bigint;
  readonly implementation: bigint;
  readonly refusal: Refusal;
  readonly degraded: boolean;
}

export interface WatchEvent {
  readonly kind: "watch";
  readonly watch: bigint;
  readonly plugin: bigint;
  readonly implementation: bigint;
  readonly change: Change;
}

export interface RevokedEvent {
  readonly kind: "revoked";
  readonly plugin: bigint;
  readonly implementation: bigint;
}

export interface ReachRefusedEvent {
  readonly kind: "reach-refused";
  readonly reachKind: ReachKind;
  readonly plugin: bigint;
  readonly id: string | null;
  readonly refusal: Refusal;
}

export interface CapacityWantedEvent {
  readonly kind: "capacity-wanted";
  readonly want: bigint;
  readonly plugin: bigint;
  readonly registration: bigint;
  readonly request: bigint;
  readonly question: CapacityQuestion;
  readonly constraints: readonly NamedNumber[];
}

export interface CapabilityEvent {
  readonly kind: "capability";
  readonly watch: bigint;
  readonly plugin: bigint;
  readonly implementation: bigint;
  readonly provider: bigint;
  readonly change: CapabilityChange;
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
  | CapabilityEvent;

type PayloadReader = (event: object, payloadOffset: number) => CoreEvent;

function readLog(event: object, payloadOffset: number): LogEvent {
  const log = decodeStruct(event, payloadOffset, "weivel_log_event");
  return { kind: "log", level: log.level as LogLevel, text: log.text as string | null };
}

function readRefused(event: object, payloadOffset: number): RefusalEvent {
  const refused = decodeStruct(event, payloadOffset, "weivel_refusal_event");
  return { kind: "refusal", refusal: readRefusal(refused.refusal as DecodedRefusal, refused.subject, refused.has_fix) };
}

function readWantSettled(event: object, payloadOffset: number): WantSettledEvent {
  const want = decodeStruct(event, payloadOffset, "weivel_want_event");
  return {
    kind: "want-settled",
    want: toBigInt(want.want),
    plugin: toBigInt(want.plugin),
    implementation: toBigInt(want.implementation),
    refusal: readRefusal(want.refusal as DecodedRefusal, want.subject, want.has_fix),
    degraded: want.degraded === 1,
  };
}

function readWatch(event: object, payloadOffset: number): WatchEvent {
  const watch = decodeStruct(event, payloadOffset, "weivel_watch_event");
  return {
    kind: "watch",
    watch: toBigInt(watch.watch),
    plugin: toBigInt(watch.plugin),
    implementation: toBigInt(watch.implementation),
    change: watch.change as Change,
  };
}

function readRevoked(event: object, payloadOffset: number): RevokedEvent {
  const revoked = decodeStruct(event, payloadOffset, "weivel_revoked_event");
  return { kind: "revoked", plugin: toBigInt(revoked.plugin), implementation: toBigInt(revoked.implementation) };
}

function readReachRefused(event: object, payloadOffset: number): ReachRefusedEvent {
  const reach = decodeStruct(event, payloadOffset, "weivel_reach_refusal");
  return {
    kind: "reach-refused",
    reachKind: reach.kind as ReachKind,
    plugin: toBigInt(reach.plugin),
    id: reach.id as string | null,
    refusal: readRefusal(reach.refusal as DecodedRefusal, reach.subject, reach.has_fix),
  };
}

function readCapacityWanted(event: object, payloadOffset: number): CapacityWantedEvent {
  const capacity = decodeStruct(event, payloadOffset, "weivel_capacity_event");
  return {
    kind: "capacity-wanted",
    want: toBigInt(capacity.want),
    plugin: toBigInt(capacity.plugin),
    registration: toBigInt(capacity.registration),
    request: toBigInt(capacity.request),
    question: capacity.question as CapacityQuestion,
    constraints: readNumbers(capacity.constraints as DecodedList),
  };
}

function readCapability(event: object, payloadOffset: number): CapabilityEvent {
  const capability = decodeStruct(event, payloadOffset, "weivel_capability_event");
  return {
    kind: "capability",
    watch: toBigInt(capability.watch),
    plugin: toBigInt(capability.plugin),
    implementation: toBigInt(capability.implementation),
    provider: toBigInt(capability.provider),
    change: capability.change as CapabilityChange,
  };
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
  return reader?.(event, offsetOf("weivel_event", "data"));
}
