import {
  CapabilityChange,
  Change,
  ReachKind,
  type CapabilityEvent,
  type CoreEvent,
  type ReachRefusedEvent,
  type RevokedEvent,
  type WantSettledEvent,
  type WatchEvent,
} from "../core/index.js";
import { answerCapacity } from "./capacity.js";
import { RefusalError } from "./refusal.js";
import type { ContextState } from "./state.js";

function settleWant(state: ContextState, event: WantSettledEvent): void {
  const pending = state.wants.lookup(event.want);
  if (pending === undefined) {
    return;
  }
  state.wants.drop(event.want);
  if (event.implementation === 0n) {
    pending.reject(new RefusalError(event.refusal));
    return;
  }
  const offered = state.services.lookup(event.implementation);
  if (offered === undefined) {
    pending.reject(new Error(`The core settled a want for ${pending.id} with a registration this layer holds no object for.`));
    return;
  }
  state.hold(event.plugin, event.implementation, ReachKind.Service, offered);
  if (event.degraded) {
    state.emit(event.plugin, { kind: "degraded", id: pending.id, refusal: event.refusal });
  }
  pending.resolve(offered.object);
}

function hearService(state: ContextState, event: WatchEvent): void {
  const watching = state.watches.lookup(event.watch);
  if (watching === undefined) {
    return;
  }
  if (event.change === Change.Registered) {
    const offered = state.services.lookup(event.implementation);
    if (offered !== undefined) {
      state.hold(event.plugin, event.implementation, ReachKind.Service, offered);
      state.notify(event.plugin, () => watching.listener(offered.object, "register"));
    }
  } else if (event.change === Change.Unregistered) {
    state.notify(event.plugin, () => watching.listener(undefined, "unregister"));
  }
}

function hearCapability(state: ContextState, event: CapabilityEvent): void {
  const watching = state.watches.lookup(event.watch);
  const offered = state.implementations.lookup(event.implementation);
  if (watching === undefined || offered === undefined) {
    return;
  }
  if (event.change === CapabilityChange.Provided) {
    state.hold(event.plugin, event.implementation, ReachKind.Capability, offered);
    state.notify(event.plugin, () => watching.listener(offered.object, "provide"));
  } else if (event.change === CapabilityChange.Withdrawn) {
    state.notify(event.plugin, () => watching.listener(offered.object, "withdraw"));
  }
}

function revoke(state: ContextState, event: RevokedEvent): void {
  const held = state.holdings.lookup(event.plugin, event.implementation);
  state.holdings.apply(event);
  if (held !== undefined) {
    state.emit(event.plugin, { kind: "revoked", reach: held.reach, id: held.id, implementation: held.implementation });
  }
}

function reportReachRefused(state: ContextState, event: ReachRefusedEvent): void {
  state.emit(event.plugin, { kind: "reach-refused", reach: event.reachKind, id: event.id, refusal: event.refusal });
}

/** Acts on one event the core reported; a log or a refusal belongs to the host, which hears every event itself. */
export function handleEvent(state: ContextState, event: CoreEvent): void {
  switch (event.kind) {
    case "want-settled":
      settleWant(state, event);
      return;
    case "watch":
      hearService(state, event);
      return;
    case "capability":
      hearCapability(state, event);
      return;
    case "revoked":
      revoke(state, event);
      return;
    case "reach-refused":
      reportReachRefused(state, event);
      return;
    case "capacity-wanted":
      answerCapacity(state, event);
      return;
    default:
      return;
  }
}
