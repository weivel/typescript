import type { Scheduler } from "../index.js";
import type { DiagnosticSink } from "./diagnostics.js";
import { pluginError } from "./errors.js";
import { unwrappedHandles } from "./handles.js";
import type { Handle, Handles } from "./handles.js";

/** Where the host records who provides and who consumes what. */
export interface Recorder {
  provided(pluginId: string, serviceId: string): void;
  consumed(pluginId: string, serviceId: string): void;
}

export type WatchEvent = "register" | "unregister";

export type WatchListener = (service: unknown | undefined, event: WatchEvent) => void;

/** One consumer's view of the registry, which is what stamps and enforces its namespace. */
export interface ConsumerRegistry {
  get(id: string): unknown | undefined;
  /** Settles once `id` is registered; with no `timeoutMillis` it never times out (invariant 8). */
  want(id: string, timeoutMillis?: number): Promise<unknown>;
  watch(id: string, listener: WatchListener): () => void;
  register(id: string, service: unknown): () => void;
  ids(): string[];
}

export interface ServiceHubOptions {
  scheduler: Scheduler;
  diagnostics: DiagnosticSink;
  recorder?: Recorder;
  /** The bare ids any consumer may register, because they name a contract rather than one plugin's offering. */
  wellKnown?: readonly string[];
  /** Defaults to `unwrappedHandles`, which reports on revocation what it cannot enforce. */
  handles?: Handles;
}

/**
 * Owns a host's own services.
 *
 * @remarks
 * A symbol rather than Java's empty string, so no `release` call, whatever id it is handed, can
 * sweep a host service away.
 */
const HOST: unique symbol = Symbol("host");

type Owner = string | typeof HOST;

/**
 * @remarks
 * A registration answers through a function rather than holding the instance, so a provider that
 * serves a differently constrained consumer differently plugs in without the hub changing.
 */
type Answer = () => unknown;

class Entry {
  private readonly handed = new Map<unknown, Handle>();
  private withdrawn = false;

  constructor(
    readonly owner: Owner,
    readonly serviceId: string,
    private readonly answer: Answer,
  ) {}

  /**
   * @implNote One handle per INSTANCE, not per lookup: withdrawal has to reach every consumer
   * already holding one, and two wrappers over one service would be equal to neither each other
   * nor it.
   * @implNote Withdrawal is re-checked after the provider answers, because a provider is plugin
   * code and may withdraw the registration while it is being asked; a handle minted then would be
   * revocable by nobody.
   */
  serve(handles: Handles): unknown {
    if (this.withdrawn) return undefined;
    const instance = this.answer();
    if (instance === undefined || instance === null || this.withdrawn) return undefined;
    const known = this.handed.get(instance);
    if (known !== undefined) return known.get();
    const handle = handles.around(this.serviceId, instance);
    this.handed.set(instance, handle);
    return handle.get();
  }

  revokeAll(): void {
    this.withdrawn = true;
    for (const handle of this.handed.values()) handle.revoke();
    this.handed.clear();
  }
}

interface Waiter {
  readonly pluginId: string;
  readonly resolve: (service: unknown) => void;
  readonly reject: (reason: unknown) => void;
  cancelTimer: () => void;
}

interface Watcher {
  readonly listener: WatchListener;
}

/**
 * The live service registry a host shares between every plugin it loads.
 *
 * @remarks
 * `get` is for optional use, `want` for an awaited arrival and `watch` for churn. That triple is
 * what lets a plugin be installed, enabled, disabled and updated at runtime while its consumers keep
 * working.
 */
export class ServiceHub {
  private readonly scheduler: Scheduler;
  private readonly diagnostics: DiagnosticSink;
  private readonly handles: Handles;
  private readonly recorder: Recorder | undefined;
  private readonly wellKnown: readonly string[];
  private readonly entries = new Map<string, Entry>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly watchers = new Map<string, Set<Watcher>>();
  private readonly stopsByConsumer = new Map<string, Set<() => void>>();

  constructor(options: ServiceHubOptions) {
    this.scheduler = options.scheduler;
    this.diagnostics = options.diagnostics;
    this.recorder = options.recorder;
    this.wellKnown = [...(options.wellKnown ?? [])];
    this.handles = options.handles ?? unwrappedHandles(options.diagnostics);
  }

  forConsumer(pluginId: string): ConsumerRegistry {
    return {
      get: (id) => {
        this.recorder?.consumed(pluginId, id);
        return this.get(id);
      },
      want: (id, timeoutMillis) => this.awaitService(pluginId, id, timeoutMillis),
      watch: (id, listener) => this.addWatcher(pluginId, id, listener),
      register: (id, service) => this.addService(pluginId, id, () => service),
      ids: () => this.ids(),
    };
  }

  /**
   * Registers a service the HOST supplies rather than a plugin.
   *
   * @implNote Owned by no consumer, so releasing one never takes it away, and exempt from
   * namespacing: the ids a host offers are ones it defines. Registering an id again replaces it,
   * because a host wiring itself up twice is a restart, not a conflict, and the handles over the
   * replaced instance are revoked: the host has stopped offering it.
   */
  hostService(id: string, service: unknown): void {
    this.entries.get(id)?.revokeAll();
    this.entries.set(id, new Entry(HOST, id, () => service));
    this.announceArrival(id);
  }

  /** The service now, or undefined, without attributing the read to a consumer. */
  get(id: string): unknown | undefined {
    return this.entries.get(id)?.serve(this.handles);
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Unregisters everything a consumer registered, stops the watchers it installed, and rejects the
   * wants it is still waiting on, so a released plugin is inert.
   */
  release(pluginId: string): void {
    for (const stop of [...(this.stopsByConsumer.get(pluginId) ?? [])]) stop();
    this.stopsByConsumer.delete(pluginId);
    for (const entry of [...this.entries.values()]) {
      if (entry.owner === pluginId) this.unregister(entry);
    }
    for (const [id, waiting] of [...this.waiters]) {
      for (const waiter of [...waiting]) {
        if (waiter.pluginId !== pluginId) continue;
        waiting.delete(waiter);
        waiter.cancelTimer();
        waiter.reject(stoppedWaiting(pluginId, id));
      }
      if (waiting.size === 0) this.waiters.delete(id);
    }
  }

  private addService(pluginId: string, id: string, answer: Answer): () => void {
    if (!this.mayRegister(pluginId, id)) {
      const name = id.includes(":") ? id.slice(id.lastIndexOf(":") + 1) : id;
      throw pluginError(
        pluginId,
        `cannot register service "${id}", which is outside this plugin's namespace`,
        `register it as "${pluginId}:${name}", or as one of the well-known ids: ${this.wellKnown.join(", ") || "(none)"}`,
      );
    }
    const existing = this.entries.get(id);
    if (existing !== undefined) {
      throw pluginError(
        pluginId,
        `service "${id}" is already registered by ${existing.owner === HOST ? "the host" : existing.owner}`,
        "disable one of the two plugins, or have each register its own namespaced id",
      );
    }
    const entry = new Entry(pluginId, id, answer);
    this.entries.set(id, entry);
    this.recorder?.provided(pluginId, id);
    this.announceArrival(id);
    return () => this.unregister(entry);
  }

  /**
   * @implNote The instance is asked for only when somebody is listening, because asking calls the
   * provider, and a registration nobody waits on must not look to it like a consumer arriving.
   */
  private announceArrival(id: string): void {
    const awaited = (this.waiters.get(id)?.size ?? 0) > 0;
    const watched = (this.watchers.get(id)?.size ?? 0) > 0;
    if (!awaited && !watched) return;
    const service = this.get(id);
    if (service === undefined) return;
    const pending = this.waiters.get(id);
    this.waiters.delete(id);
    for (const waiter of pending ?? []) {
      waiter.cancelTimer();
      waiter.resolve(service);
    }
    this.notifyWatchers(id, service, "register");
  }

  private unregister(entry: Entry): void {
    if (this.entries.get(entry.serviceId) !== entry) return;
    this.entries.delete(entry.serviceId);
    entry.revokeAll();
    this.notifyWatchers(entry.serviceId, undefined, "unregister");
  }

  /**
   * @implNote A no-op catch is attached before the promise is returned: release rejects every
   * pending want, and a plugin that asked and dropped the promise would otherwise crash Node with
   * an unhandled rejection. A caller that chains on it still sees the rejection.
   */
  private awaitService(pluginId: string, id: string, timeoutMillis: number | undefined): Promise<unknown> {
    this.recorder?.consumed(pluginId, id);
    const now = this.get(id);
    const asked =
      now !== undefined
        ? Promise.resolve(now)
        : new Promise<unknown>((resolve, reject) => this.enqueue(pluginId, id, timeoutMillis, resolve, reject));
    asked.catch(() => {});
    return asked;
  }

  private enqueue(
    pluginId: string,
    id: string,
    timeoutMillis: number | undefined,
    resolve: (service: unknown) => void,
    reject: (reason: unknown) => void,
  ): void {
    const waiter: Waiter = { pluginId, resolve, reject, cancelTimer: () => {} };
    if (timeoutMillis !== undefined) {
      waiter.cancelTimer = this.scheduler.schedule(() => {
        this.waiters.get(id)?.delete(waiter);
        if (this.waiters.get(id)?.size === 0) this.waiters.delete(id);
        reject(
          pluginError(
            pluginId,
            `waited ${timeoutMillis}ms for service "${id}" and nothing registered it`,
            `install a plugin that provides "${id}", or use get() and carry on without it`,
          ),
        );
      }, timeoutMillis);
    }
    const waiting = this.waiters.get(id) ?? new Set<Waiter>();
    waiting.add(waiter);
    this.waiters.set(id, waiting);
  }

  private addWatcher(pluginId: string, id: string, listener: WatchListener): () => void {
    this.recorder?.consumed(pluginId, id);
    const watcher: Watcher = { listener };
    const installed = this.watchers.get(id) ?? new Set<Watcher>();
    installed.add(watcher);
    this.watchers.set(id, installed);
    const stops = this.stopsByConsumer.get(pluginId) ?? new Set<() => void>();
    this.stopsByConsumer.set(pluginId, stops);
    const stop = (): void => {
      installed.delete(watcher);
      if (installed.size === 0 && this.watchers.get(id) === installed) this.watchers.delete(id);
      stops.delete(stop);
      if (stops.size === 0 && this.stopsByConsumer.get(pluginId) === stops) this.stopsByConsumer.delete(pluginId);
    };
    stops.add(stop);
    return stop;
  }

  /**
   * @implNote A watcher that throws is reported and the rest still hear, because one bad consumer
   * must not stop the others learning of a registration. One removed mid-iteration is skipped.
   */
  private notifyWatchers(id: string, service: unknown, event: WatchEvent): void {
    const installed = this.watchers.get(id);
    if (installed === undefined) return;
    for (const watcher of [...installed]) {
      if (!installed.has(watcher)) continue;
      try {
        watcher.listener(service, event);
      } catch (failure) {
        this.diagnostics(`a watcher of "${id}" threw while handling ${event}: ${String(failure)}`);
      }
    }
  }

  private mayRegister(pluginId: string, serviceId: string): boolean {
    if (this.wellKnown.includes(serviceId)) return true;
    const separator = serviceId.indexOf(":");
    if (separator <= 0 || separator === serviceId.length - 1) return false;
    return serviceId.slice(0, separator) === pluginId;
  }
}

function stoppedWaiting(pluginId: string, id: string): Error {
  return pluginError(
    pluginId,
    `stopped while waiting for service "${id}"`,
    `provide "${id}" before this plugin is stopped, or use get() and carry on without it`,
  );
}
