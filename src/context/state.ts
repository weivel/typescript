import type { Core, CoreEvent, ReachKind } from "../core/index.js";
import { HandleTable, HoldingTable } from "../handles/index.js";
import type { Clock } from "../timer/index.js";
import { DeferredEvents } from "./deferred-events.js";
import type { CapacityProvider, Logger, PluginEvent, PluginEventListener } from "./model.js";
import { DetachedError } from "./refusal.js";

/** Whether a plugin's context still reaches the core: detached once the core has forgotten the plugin. */
export interface Attachment {
  readonly plugin: bigint;
  detached: boolean;
}

/** Throws DetachedError for a call through a detached context, decided as the call is made. */
export function ensureAttached(attachment: Attachment): void {
  if (attachment.detached) {
    throw new DetachedError(attachment.plugin);
  }
}

/** An object a plugin or the host offered, by the handle the core answered for it. */
export interface Offered {
  readonly id: string;
  readonly object: unknown;
  readonly owner: bigint;
  /** What answers a constrained want's questions, when the registration declared one. */
  readonly capacity?: CapacityProvider;
  /** Whether it was registered with weivel_register_service_awaiting_releases, so each holding outlives its revocation. */
  readonly awaitsReleases?: boolean;
  /**
   * For a registration the host offers plugins one by one, the object each plugin is offered, by plugin; a plugin it
   * names nothing for is offered nothing, and `object` is not read.
   */
  readonly offeredTo?: ReadonlyMap<bigint, unknown>;
}

/** What `plugin` reaches through an offered registration: its own object, where the host offers one per plugin. */
export function objectFor(offered: Offered, plugin: bigint): unknown {
  return offered.offeredTo === undefined ? offered.object : offered.offeredTo.get(plugin);
}

/** A registration made awaiting releases, kept until the core says every holding of it has ended. */
export interface AwaitingReleases {
  readonly owner: bigint;
  /** Tells the owner nothing holds what it registered any more. */
  readonly released: () => void;
}

/** What a plugin holds, by the implementation handle the core handed it. */
export interface Held {
  readonly reach: ReachKind;
  readonly id: string;
  readonly implementation: unknown;
  readonly awaitsReleases: boolean;
}

export interface PendingWant {
  readonly plugin: bigint;
  readonly id: string;
  readonly resolve: (service: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

export interface Watching {
  readonly plugin: bigint;
  readonly listener: (implementation: unknown, change: string) => void;
}

export interface PluginState {
  readonly log: Logger;
  readonly eventListeners: Set<PluginEventListener>;
  /** Every live handle the core answered this plugin, so forgetting it drops each from the tables. */
  readonly handles: Set<bigint>;
  readonly attachment: Attachment;
  /** How many events the core had drained when the context was made; none of those ever reaches it. */
  readonly madeAfter: number;
}

/** The tables every context of one core shares, and the calls through which they change. */
export class ContextState {
  readonly core: Core;
  readonly clock: Clock;
  readonly services = new HandleTable<Offered>();
  readonly implementations = new HandleTable<Offered>();
  readonly holdings = new HoldingTable<Held>();
  readonly wants = new HandleTable<PendingWant>();
  readonly watches = new HandleTable<Watching>();
  readonly awaitingReleases = new HandleTable<AwaitingReleases>();
  /** Each capability a loaded library publishes a contract for, as the operations an implementation of it offers. */
  readonly contracts = new Map<string, readonly string[]>();
  /** Each revoked holding the core keeps until its holder releases it: the registrations, by holder. */
  readonly #revokedHoldings = new Map<bigint, Set<bigint>>();
  readonly plugins = new Map<bigint, PluginState>();
  readonly #fallbackLog: Logger;
  readonly #deferred: DeferredEvents;
  /** Registrations and implementations the core has ended, kept until every event queued before the end is handled. */
  readonly #ended = new Map<bigint, bigint>();

  constructor(core: Core, clock: Clock, fallbackLog: Logger, handle: (event: CoreEvent) => void) {
    this.core = core;
    this.clock = clock;
    this.#fallbackLog = fallbackLog;
    this.#deferred = new DeferredEvents(
      handle,
      (error, event) => core.reportListenerError(error, event),
      () => this.#dropEnded(),
    );
    core.addDrainListener(() => this.dropEndedWhenIdle());
  }

  receive(event: CoreEvent): void {
    this.#deferred.receive(event);
  }

  /** Runs `step` once every event received so far has been handled. */
  whenHandled(step: () => void): void {
    this.#deferred.whenHandled(step);
  }

  /** Makes a core call and records what it answered before any event it caused is handled. */
  call<Value>(callAndRecord: () => Value): Value {
    return this.#deferred.around(callAndRecord);
  }

  logOf(plugin: bigint): Logger {
    return this.plugins.get(plugin)?.log ?? this.#fallbackLog;
  }

  rememberHandle(plugin: bigint, handle: bigint): void {
    this.plugins.get(plugin)?.handles.add(handle);
  }

  forgetHandle(plugin: bigint, handle: bigint): void {
    this.plugins.get(plugin)?.handles.delete(handle);
  }

  hasEnded(handle: bigint): boolean {
    return this.#ended.has(handle);
  }

  /**
   * Marks a registration or implementation the core has ended. Its object stays answerable to the events the core
   * queued before the end, and is dropped once the layer is idle.
   */
  markEnded(owner: bigint, handle: bigint): void {
    if (this.services.has(handle) || this.implementations.has(handle)) {
      this.#ended.set(handle, owner);
    }
  }

  dropWatch(watch: bigint): void {
    const watching = this.watches.lookup(watch);
    if (watching !== undefined) {
      this.watches.drop(watch);
      this.forgetHandle(watching.plugin, watch);
    }
  }

  dropWant(want: bigint): void {
    const pending = this.wants.lookup(want);
    if (pending !== undefined) {
      this.wants.drop(want);
      this.forgetHandle(pending.plugin, want);
    }
  }

  /** Calls a plugin's listener; a throw goes to the error sink and never further, so the others still hear. */
  notify(listener: () => void, event?: CoreEvent): void {
    try {
      listener();
    } catch (error) {
      this.core.reportListenerError(error, event);
    }
  }

  /** Whether `event` was drained before the context of `plugin` was made, so it must never reach that context. */
  precedesContextOf(plugin: bigint, event: CoreEvent): boolean {
    const sequence = this.core.sequenceOf(event);
    const state = this.plugins.get(plugin);
    return sequence !== undefined && state !== undefined && sequence <= state.madeAfter;
  }

  emit(plugin: bigint, event: PluginEvent): void {
    const state = this.plugins.get(plugin);
    if (state === undefined) {
      return;
    }
    for (const listener of [...state.eventListeners]) {
      this.notify(() => listener(event));
    }
  }

  hold(plugin: bigint, implementation: bigint, reach: ReachKind, offered: Offered): void {
    this.holdings.hold(plugin, implementation, {
      reach,
      id: offered.id,
      implementation: objectFor(offered, plugin),
      awaitsReleases: offered.awaitsReleases === true,
    });
  }

  /** Keeps a revoked holding the core keeps too, until its holder releases it. */
  keepRevokedHolding(holder: bigint, registration: bigint): void {
    let registrations = this.#revokedHoldings.get(holder);
    if (registrations === undefined) {
      registrations = new Set();
      this.#revokedHoldings.set(holder, registrations);
    }
    registrations.add(registration);
  }

  /** Takes a kept revoked holding away, answering whether there was one to take. */
  takeRevokedHolding(holder: bigint, registration: bigint): boolean {
    const registrations = this.#revokedHoldings.get(holder);
    const taken = registrations?.delete(registration) ?? false;
    if (registrations?.size === 0) {
      this.#revokedHoldings.delete(holder);
    }
    return taken;
  }

  /** Drops every revoked holding of a holder the core ended them with, released, quarantined or forgotten. */
  dropRevokedHoldingsOf(holder: bigint): void {
    this.#revokedHoldings.delete(holder);
  }

  /** Drops every registration `owner` made awaiting releases, so it hears none of their releases. */
  dropAwaitingReleasesOf(owner: bigint): void {
    for (const [registration, awaiting] of [...this.awaitingReleases.entries()]) {
      if (awaiting.owner === owner) {
        this.awaitingReleases.drop(registration);
      }
    }
  }

  /** Drops what the core has ended, unless an event queued before the end may still wait to be handled. */
  dropEndedWhenIdle(): void {
    if (this.#deferred.idle) {
      this.#dropEnded();
    }
  }

  #dropEnded(): void {
    for (const [handle, owner] of this.#ended) {
      this.services.drop(handle);
      this.implementations.drop(handle);
      this.forgetHandle(owner, handle);
    }
    this.#ended.clear();
  }
}
