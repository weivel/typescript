import { Choice, HandleCondition, ReachKind, Status, type CallResult, type WantOptions as CoreWantOptions } from "../core/index.js";
import type { CapacityProvider, RegisterOptions, ServiceListener, Services, ServiceType, Want, WantOptions } from "./model.js";
import { DetachedError, failureOf } from "./refusal.js";
import { ensureAttached, type Attachment, type ContextState } from "./state.js";

function encodeWant(options: WantOptions, now: number): CoreWantOptions {
  return {
    timed: options.timeoutMillis === undefined ? Choice.Default : Choice.Yes,
    now,
    timeoutMillis: options.timeoutMillis ?? 0,
    budgeted: options.budgetMillis === undefined ? Choice.Default : Choice.Yes,
    budgetMillis: options.budgetMillis ?? 0,
    pollMillis: options.pollMillis ?? 0,
  };
}

/**
 * Whether the core reads the want's `now`: for a timeout, and for a constrained want, which needs a poll interval and
 * may have a budget. Only then is the clock read.
 */
function needsTheTime(options: WantOptions): boolean {
  return options.timeoutMillis !== undefined || options.budgetMillis !== undefined || options.pollMillis !== undefined;
}

function answered(result: CallResult<bigint>): bigint | undefined {
  return result.status === Status.Ok ? result.value : undefined;
}

/** How a registration is made: what answers its capacity questions, and whom its releases are told to. */
export interface Registering {
  readonly capacity?: CapacityProvider;
  /**
   * Registers with weivel_register_service_awaiting_releases, calling this once every holding of the registration has
   * ended since it was unregistered.
   */
  readonly whenReleased?: () => void;
}

/** Registers `object` under `id` for `owner`, a plugin or the host; the answer unregisters it. */
export function registerService(state: ContextState, owner: bigint, id: string, object: unknown, registering: Registering = {}): () => void {
  const { capacity, whenReleased } = registering;
  const call = whenReleased === undefined ? "weivel_register_service" : "weivel_register_service_awaiting_releases";
  const result = state.call(() => {
    const registered =
      whenReleased === undefined ? state.core.registerService(owner, id) : state.core.registerServiceAwaitingReleases(owner, id);
    const registration = answered(registered);
    if (registration !== undefined) {
      state.services.add(registration, { id, object, owner, capacity, awaitsReleases: whenReleased !== undefined });
      state.rememberHandle(owner, registration);
      if (whenReleased !== undefined) {
        state.awaitingReleases.add(registration, { owner, released: whenReleased });
      }
    }
    return registered;
  });
  const registration = answered(result);
  if (registration === undefined) {
    throw failureOf(call, result);
  }
  return () => unregisterService(state, owner, registration);
}

/**
 * Ends `holder`'s revoked holding of a registration made awaiting releases, once; a holding the core already ended
 * with its holder is not asked for again.
 *
 * @implNote The core refuses a holding it ended when it released or quarantined the holder, which can happen before
 * the layer drops its record of it; that refusal says nothing went wrong, so only another failure is reported.
 */
export function releaseHolding(state: ContextState, holder: bigint, registration: bigint): void {
  if (!state.revokedHoldings.drop(holder, registration)) {
    return;
  }
  const released = state.call(() => state.core.releaseHolding(holder, registration));
  if (released.status !== Status.Ok && released.status !== Status.Refused) {
    state.core.reportListenerError(failureOf("weivel_release_holding", released));
  }
}

function unregisterService(state: ContextState, owner: bigint, registration: bigint): void {
  if (!state.services.has(registration) || state.hasEnded(registration)) {
    return;
  }
  state.call(() => {
    state.core.unregister(registration);
    state.markEnded(owner, registration);
  });
}

/** Ends a watch the core still runs; one it already ended is only dropped. */
export function stopWatching(state: ContextState, watch: bigint): void {
  if (!state.watches.has(watch)) {
    return;
  }
  state.call(() => {
    if (state.core.handleState(watch).value === HandleCondition.Watching) {
      state.core.unregister(watch);
    }
    state.dropWatch(watch);
  });
}

/**
 * Records a watch the core answered, answering its disposer.
 *
 * @throws RefusalError, or the status alone where the core queued no refusal, when the core refused the watch.
 */
export function startWatching(
  state: ContextState,
  plugin: bigint,
  call: string,
  watch: () => CallResult<bigint>,
  listener: (implementation: unknown, change: string) => void,
): () => void {
  const result = state.call(() => {
    const watched = watch();
    const handle = answered(watched);
    if (handle !== undefined) {
      state.watches.add(handle, { plugin, listener });
      state.rememberHandle(plugin, handle);
    }
    return watched;
  });
  const watchHandle = answered(result);
  if (watchHandle === undefined) {
    throw failureOf(call, result);
  }
  return () => stopWatching(state, watchHandle);
}

/** The provider's object, or undefined when nothing is registered under `id`; a refusal is thrown, absence is not. */
function get(state: ContextState, plugin: bigint, id: string): unknown {
  const { got, offered } = state.call(() => {
    const got = state.core.getService(plugin, id);
    const registration = answered(got);
    const offered = registration === undefined ? undefined : state.services.lookup(registration);
    if (registration !== undefined && offered !== undefined) {
      state.hold(plugin, registration, ReachKind.Service, offered);
    }
    return { got, offered };
  });
  if (got.status !== Status.Ok && got.status !== Status.None) {
    throw failureOf("weivel_get_service", got);
  }
  return offered?.object;
}

function ids(state: ContextState, plugin: bigint): string[] {
  const listed = state.call(() => state.core.serviceIds(plugin));
  if (listed.status !== Status.Ok || listed.value === undefined) {
    throw failureOf("weivel_service_ids", listed);
  }
  return listed.value;
}

function want(state: ContextState, attachment: Attachment, id: string, options: WantOptions): Want<unknown> {
  const plugin = attachment.plugin;
  let made: bigint | undefined;
  const settlement = new Promise((resolve, reject) => {
    const result = state.call(() => {
      const wanted = state.core.wantService(plugin, id, encodeWant(options, needsTheTime(options) ? state.clock.now() : 0));
      const wantHandle = answered(wanted);
      if (wantHandle !== undefined) {
        state.wants.add(wantHandle, { plugin, id, resolve, reject });
        state.rememberHandle(plugin, wantHandle);
      }
      return wanted;
    });
    made = answered(result);
    if (made === undefined) {
      reject(failureOf("weivel_want_service", result));
    }
  });
  return withdrawable(settlement, () => withdraw(state, attachment, made));
}

function withdrawable<Service>(settlement: Promise<Service>, withdrawal: () => boolean): Want<Service> {
  return Object.assign(settlement, { withdraw: withdrawal });
}

/**
 * Withdraws a want the core still holds waiting.
 *
 * @implNote A want the core settled is not withdrawn even before its settlement is dispatched: the core would refuse
 * the stale handle with a refusal of its own, and the settlement still arrives.
 */
function withdraw(state: ContextState, attachment: Attachment, want: bigint | undefined): boolean {
  ensureAttached(attachment);
  if (want === undefined || !state.wants.has(want)) {
    return false;
  }
  return state.call(() => {
    if (state.core.handleState(want).value !== HandleCondition.Waiting || state.core.unregister(want).status !== Status.Ok) {
      return false;
    }
    state.dropWant(want);
    return true;
  });
}

/** The services of a context; a call through a detached one throws, or rejects, DetachedError and reaches nothing. */
export function createServices(state: ContextState, attachment: Attachment): Services {
  const plugin = attachment.plugin;
  return {
    get: <Service>(type: ServiceType<Service>) => {
      ensureAttached(attachment);
      return get(state, plugin, type.id) as Service | undefined;
    },
    ids: () => {
      ensureAttached(attachment);
      return ids(state, plugin);
    },
    register: <Service>(type: ServiceType<Service>, service: Service, options: RegisterOptions = {}) => {
      ensureAttached(attachment);
      return registerService(state, plugin, type.id, service, {
        capacity: options.capacity,
        ...(options.awaitReleases === true
          ? { whenReleased: () => state.emit(plugin, { kind: "holdings-released", id: type.id, service }) }
          : {}),
      });
    },
    want: <Service>(type: ServiceType<Service>, options: WantOptions = {}) =>
      (attachment.detached
        ? withdrawable(Promise.reject(new DetachedError(plugin)), () => {
            throw new DetachedError(plugin);
          })
        : want(state, attachment, type.id, options)) as Want<Service>,
    watch: <Service>(type: ServiceType<Service>, listener: ServiceListener<Service>) => {
      ensureAttached(attachment);
      return startWatching(
        state,
        plugin,
        "weivel_watch_service",
        () => state.core.watchService(plugin, type.id),
        listener as (implementation: unknown, change: string) => void,
      );
    },
  };
}
