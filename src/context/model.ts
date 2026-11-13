import type { Manifest, ReachKind, Refusal } from "../core/index.js";

/** A service id paired, in the type system, with the object its provider registers under it. */
export interface ServiceType<Service> {
  /** Never present at run time; it keeps two keys parameterised differently from being interchanged. */
  readonly __phantom?: Service;
  readonly id: string;
}

/** A capability id paired, in the type system, with the implementation its providers hand over. */
export interface CapabilityType<Implementation> {
  /** Never present at run time; it keeps two keys parameterised differently from being interchanged. */
  readonly __phantom?: Implementation;
  readonly id: string;
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string, cause?: unknown): void;
}

/** How a want waits; every field is handed to the core, which decides what it means for the want. */
export interface WantOptions {
  /** Milliseconds to wait before giving up; absent waits for as long as it takes (invariant 8). */
  readonly timeoutMillis?: number;
  /** For a constrained want, how long it polls before it degrades or is refused; absent polls without end. */
  readonly budgetMillis?: number;
  /** For a constrained want, how often its provider is asked; the core refuses a constrained want without it. */
  readonly pollMillis?: number;
}

/** How a service is registered. */
export interface RegisterOptions {
  /**
   * What answers a constrained want's questions about this registration. Without it the registration adds no live
   * attributes, so its manifest's advertised attributes stand, and it serves every consumer.
   */
  readonly capacity?: CapacityProvider;
}

export type ServiceChange = "register" | "unregister";
export type ImplementationChange = "provide" | "withdraw";

/** Hears a watched service: the provider's object when it is registered, nothing when it is unregistered. */
export type ServiceListener<Service> = (service: Service | undefined, change: ServiceChange) => void;

/** Hears a watched capability: the implementation that joined or left. */
export type ImplementationListener<Implementation> = (implementation: Implementation, change: ImplementationChange) => void;

/** How a plugin reaches another plugin's service, and offers its own. */
export interface Services {
  /** The provider's own object registered under the id now, or undefined when nothing the core answers is. */
  get<Service>(type: ServiceType<Service>): Service | undefined;
  /** The ids this plugin may reach that are registered now, in its manifest's order. */
  ids(): string[];
  /**
   * Registers `service` under the id until the answered function is called.
   *
   * @throws RefusalError when the core refuses the registration.
   */
  register<Service>(type: ServiceType<Service>, service: Service, options?: RegisterOptions): () => void;
  /** Settles once, when the core settles the want: with the provider's object, or rejected with a RefusalError. */
  want<Service>(type: ServiceType<Service>, options?: WantOptions): Promise<Service>;
  /** Hears every later registration and removal the core reports for the id, until the answered function is called. */
  watch<Service>(type: ServiceType<Service>, listener: ServiceListener<Service>): () => void;
}

/** How a plugin sees the implementations of a capability: only those whose providers' activations were verified. */
export interface Capabilities {
  /** Every verified implementation now, in the order the core answers them. */
  all<Implementation>(type: CapabilityType<Implementation>): Implementation[];
  /** Hears every implementation that joins or leaves from now on, until the answered function is called. */
  watch<Implementation>(type: CapabilityType<Implementation>, listener: ImplementationListener<Implementation>): () => void;
}

/** Something this plugin held was withdrawn, so it must stop using it. */
export interface RevokedPluginEvent {
  readonly kind: "revoked";
  readonly reach: ReachKind;
  readonly id: string;
  readonly implementation: unknown;
}

/** The core refused this plugin a service or capability it does not reach. */
export interface ReachRefusedPluginEvent {
  readonly kind: "reach-refused";
  readonly reach: ReachKind;
  readonly id: string | null;
  readonly refusal: Refusal;
}

/** A constrained want settled with a provider that never met `refusal.subject`, its budget spent. */
export interface DegradedPluginEvent {
  readonly kind: "degraded";
  readonly id: string;
  readonly refusal: Refusal;
}

/** What the core reported about this plugin. */
export type PluginEvent = RevokedPluginEvent | ReachRefusedPluginEvent | DegradedPluginEvent;

export type PluginEventListener = (event: PluginEvent) => void;

export interface PluginEvents {
  /** Hears what the core reports about this plugin from now on, until the answered function is called. */
  listen(listener: PluginEventListener): () => void;
}

/**
 * What answers a constrained want's questions about a registration that declared it; both methods are optional, and
 * the provider's object may be its own capacity provider.
 *
 * @remarks `attributes` answers what the provider offers now, laid by the core over what its manifest advertises;
 * left out, the advertised attributes stand. `serves` answers whether it serves a consumer under those constraints;
 * left out, it serves every consumer.
 */
export interface CapacityProvider {
  attributes?(): Readonly<Record<string, number>>;
  serves?(constraints: Readonly<Record<string, number>>): boolean;
}

/** Everything a plugin sees of the core, and the only way it reaches any of it. */
export interface PluginContext {
  readonly capabilities: Capabilities;
  capability<Implementation>(id: string): CapabilityType<Implementation>;
  readonly events: PluginEvents;
  readonly log: Logger;
  readonly manifest: Manifest;
  /**
   * Provides the implementation of a capability the manifest declares; it reaches consumers once the host's
   * activation check passes.
   *
   * @throws RefusalError when the core refuses it.
   */
  provide<Implementation>(type: CapabilityType<Implementation>, implementation: Implementation): void;
  service<Service>(id: string): ServiceType<Service>;
  readonly services: Services;
}
