import type { Core, CoreEvent, ReachKind } from "../core/index.js";
import { HandleTable, HoldingTable } from "../handles/index.js";
import type { Clock } from "../timer/index.js";
import { DeferredEvents } from "./deferred-events.js";
import type { CapacityProvider, Logger, PluginEvent, PluginEventListener } from "./model.js";

/** An object a plugin or the host offered, by the handle the core answered for it. */
export interface Offered {
  readonly id: string;
  readonly object: unknown;
  readonly owner: bigint;
  /** What answers a constrained want's questions, when the registration declared one. */
  readonly capacity?: CapacityProvider;
}

/** What a plugin holds, by the implementation handle the core handed it. */
export interface Held {
  readonly reach: ReachKind;
  readonly id: string;
  readonly implementation: unknown;
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

  /** Calls a plugin's listener; a throw is the plugin's own fault, logged on its log and never passed on. */
  notify(plugin: bigint, listener: () => void): void {
    try {
      listener();
    } catch (error) {
      this.logOf(plugin).error("A listener threw; the others still hear every change.", error);
    }
  }

  emit(plugin: bigint, event: PluginEvent): void {
    const state = this.plugins.get(plugin);
    if (state === undefined) {
      return;
    }
    for (const listener of [...state.eventListeners]) {
      this.notify(plugin, () => listener(event));
    }
  }

  hold(plugin: bigint, implementation: bigint, reach: ReachKind, offered: Offered): void {
    this.holdings.hold(plugin, implementation, { reach, id: offered.id, implementation: offered.object });
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
