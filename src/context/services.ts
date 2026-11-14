import { Choice, HandleCondition, ReachKind, Status, type CallResult, type WantOptions as CoreWantOptions } from "../core/index.js";
import type { CapacityProvider, RegisterOptions, ServiceListener, Services, ServiceType, WantOptions } from "./model.js";
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

/** Registers `object` under `id` for `owner`, a plugin or the host; the answer unregisters it. */
export function registerService(
  state: ContextState,
  owner: bigint,
  id: string,
  object: unknown,
  capacity?: CapacityProvider,
): () => void {
  const result = state.call(() => {
    const registered = state.core.registerService(owner, id);
    const registration = answered(registered);
    if (registration !== undefined) {
      state.services.add(registration, { id, object, owner, capacity });
      state.rememberHandle(owner, registration);
    }
    return registered;
  });
  const registration = answered(result);
  if (registration === undefined) {
    throw failureOf("weivel_register_service", result);
  }
  return () => unregisterService(state, owner, registration);
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

function want(state: ContextState, plugin: bigint, id: string, options: WantOptions): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const result = state.call(() => {
      const wanted = state.core.wantService(plugin, id, encodeWant(options, needsTheTime(options) ? state.clock.now() : 0));
      const wantHandle = answered(wanted);
      if (wantHandle !== undefined) {
        state.wants.add(wantHandle, { plugin, id, resolve, reject });
        state.rememberHandle(plugin, wantHandle);
      }
      return wanted;
    });
    if (answered(result) === undefined) {
      reject(failureOf("weivel_want_service", result));
    }
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
      return registerService(state, plugin, type.id, service, options.capacity);
    },
    want: <Service>(type: ServiceType<Service>, options: WantOptions = {}) =>
      attachment.detached ? Promise.reject(new DetachedError(plugin)) : (want(state, plugin, type.id, options) as Promise<Service>),
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
