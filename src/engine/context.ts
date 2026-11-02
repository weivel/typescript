import type {
  CapabilityType,
  ConfigSetOptions,
  Events,
  HomeDescriptor,
  HostDescriptor,
  Logger,
  PluginConfig,
  PluginContext,
  PluginManifest,
  PluginPaths,
  PluginSecrets,
  Services,
  ServiceType,
  TopicType,
  WantOptions,
} from "../index.js";
import { pluginError } from "./errors.js";
import type { ConsumerRegistry } from "./registry.js";

/** The bus a host supplies per plugin, in ids and untyped payloads; the context attaches the types. */
export interface RuntimeEvents {
  publish(topic: string, payload: unknown): void;
  subscribe(topic: string, listener: (payload: unknown) => void): () => void;
}

/** What a host supplies per plugin, the second argument to `contextFor`. */
export interface PluginRuntime {
  config: PluginConfig;
  log: Logger;
  paths: PluginPaths;
  events: RuntimeEvents;
  /** Every app home the host knows about. Absent means it knows of none. */
  homes?: { all(): HomeDescriptor[] };
  /** The plugin's secrets, already scoped to its id. Absent means this host has no secret store. */
  secrets?: PluginSecrets;
}

/** What the host opened for one plugin, from which its context is built. */
export interface Session {
  readonly manifest: PluginManifest;
  readonly host: HostDescriptor;
  readonly runtime: PluginRuntime;
  /** Already fenced and attributed to the plugin. */
  readonly registry: ConsumerRegistry;
  /** Already fenced, recording and released with the plugin. */
  readonly events: RuntimeEvents;
  provide(capabilityId: string, implementation: unknown): void;
}

/**
 * The context one plugin's activation receives.
 *
 * @remarks
 * `manifest`, `log`, `paths` and `secrets` are handed over by identity, never rebuilt (invariant 4).
 * `config` is fenced, so a portable write on a host without the layer is refused (invariant 13),
 * and a member the runtime omits stays absent rather than arriving as a stub.
 */
export function contextOf(session: Session): PluginContext {
  const { runtime } = session;
  return {
    capability: (id) => ({ id }),
    service: (id) => ({ id }),
    topic: (id) => ({ id }),
    config: configOver(session.manifest.id, runtime),
    log: runtime.log,
    paths: runtime.paths,
    manifest: session.manifest,
    host: session.host,
    homes: () => runtime.homes?.all() ?? [],
    provide: (type, implementation) => session.provide(capabilityIdOf(type), implementation),
    services: servicesOver(session.registry),
    events: eventsOver(session.events),
    ...(runtime.secrets === undefined ? {} : { secrets: runtime.secrets }),
  };
}

function configOver(pluginId: string, runtime: PluginRuntime): PluginConfig {
  const settings = runtime.config;
  const hasPortableLayer = runtime.paths.portable !== undefined;
  function set(key: string, value: unknown): Promise<void>;
  function set(key: string, value: unknown, options: ConfigSetOptions): Promise<void>;
  function set(key: string, value: unknown, options?: ConfigSetOptions): Promise<void> {
    if (options === undefined) return settings.set(key, value);
    if (options.layer === "portable" && !hasPortableLayer) return Promise.reject(noPortableLayer(pluginId));
    return settings.set(key, value, options);
  }
  return { all: () => settings.all(), get: <T>(key: string) => settings.get<T>(key), set };
}

function noPortableLayer(pluginId: string): Error {
  return pluginError(pluginId, "this host has no portable settings layer", 'write to the "application" layer, or run on a host that offers paths.portable');
}

/**
 * @implNote Each typed member is an overload over an untyped implementation, never an assertion:
 * the registry and the bus work in ids, and a typed key is exactly the promise that the id names a
 * `T`, so the overload states that promise where the contract made it.
 */
function servicesOver(registry: ConsumerRegistry): Services {
  function get<T>(type: ServiceType<T>): T | undefined;
  function get(type: ServiceType<unknown>): unknown {
    return registry.get(type.id);
  }
  function want<T>(type: ServiceType<T>, options?: WantOptions): Promise<T>;
  function want(type: ServiceType<unknown>, options?: WantOptions): Promise<unknown> {
    const timeoutMs = options?.timeoutMs;
    return timeoutMs === undefined ? registry.want(type.id) : registry.want(type.id, timeoutMs);
  }
  function watch<T>(type: ServiceType<T>, listener: (a: T, b: string) => void): () => void;
  function watch(type: ServiceType<unknown>, listener: (a: unknown, b: string) => void): () => void {
    return registry.watch(type.id, listener);
  }
  return {
    get,
    want,
    watch,
    register: (type, implementation) => registry.register(type.id, implementation),
    ids: () => registry.ids(),
  };
}

function eventsOver(bus: RuntimeEvents): Events {
  function subscribe<T>(topic: TopicType<T>, listener: (value: T) => void): () => void;
  function subscribe(topic: TopicType<unknown>, listener: (value: unknown) => void): () => void {
    return bus.subscribe(topic.id, listener);
  }
  return { publish: (topic, payload) => bus.publish(topic.id, payload), subscribe };
}

/** @throws when handed anything but a typed key, which is the only form the contract takes (decision 5). */
function capabilityIdOf(type: CapabilityType<unknown>): string {
  const id: unknown = typeof type === "object" && type !== null ? type.id : undefined;
  if (typeof id !== "string") {
    throw new TypeError(`provide takes a typed key, and was handed ${typeof type}: pass context.capability(id)`);
  }
  return id;
}
