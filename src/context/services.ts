import { Choice, HandleCondition, ReachKind, Status, type CallResult, type WantOptions as CoreWantOptions } from "../core/index.js";
import type { CapacityProvider, RegisterOptions, ServiceListener, Services, ServiceType, WantOptions } from "./model.js";
import { failureOf } from "./refusal.js";
import type { ContextState } from "./state.js";

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

/** Records a watch the core answered, or answers an inert one when it refused. */
export function startWatching(
  state: ContextState,
  plugin: bigint,
  watch: () => CallResult<bigint>,
  listener: (implementation: unknown, change: string) => void,
): () => void {
  const watchHandle = state.call(() => {
    const handle = answered(watch());
    if (handle !== undefined) {
      state.watches.add(handle, { plugin, listener });
      state.rememberHandle(plugin, handle);
    }
    return handle;
  });
  return watchHandle === undefined ? () => {} : () => stopWatching(state, watchHandle);
}

function get(state: ContextState, plugin: bigint, id: string): unknown {
  return state.call(() => {
    const registration = answered(state.core.getService(plugin, id));
    const offered = registration === undefined ? undefined : state.services.lookup(registration);
    if (registration === undefined || offered === undefined) {
      return undefined;
    }
    state.hold(plugin, registration, ReachKind.Service, offered);
    return offered.object;
  });
}

function want(state: ContextState, plugin: bigint, id: string, options: WantOptions): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const result = state.call(() => {
      const wanted = state.core.wantService(plugin, id, encodeWant(options, state.clock.now()));
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

export function createServices(state: ContextState, plugin: bigint): Services {
  return {
    get: <Service>(type: ServiceType<Service>) => get(state, plugin, type.id) as Service | undefined,
    ids: () => state.call(() => state.core.serviceIds(plugin)).value ?? [],
    register: <Service>(type: ServiceType<Service>, service: Service, options: RegisterOptions = {}) =>
      registerService(state, plugin, type.id, service, options.capacity),
    want: <Service>(type: ServiceType<Service>, options: WantOptions = {}) =>
      want(state, plugin, type.id, options) as Promise<Service>,
    watch: <Service>(type: ServiceType<Service>, listener: ServiceListener<Service>) =>
      startWatching(
        state,
        plugin,
        () => state.core.watchService(plugin, type.id),
        listener as (implementation: unknown, change: string) => void,
      ),
  };
}
