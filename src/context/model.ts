import type { Manifest, ReachKind, Refusal } from "../core/index.js";
import type { DescribedEnums, EnumNames, RequiredEnums } from "./described-enums.js";

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
  /**
   * Keeps each holding of the registration past its revocation until its holder releases it, and tells this plugin
   * by a `holdings-released` event once every holding has ended since it was unregistered, so whatever stood behind
   * the object may be freed then.
   */
  readonly awaitReleases?: boolean;
}

export type ServiceChange = "register" | "unregister";
export type ImplementationChange = "provide" | "withdraw";

/** Hears a watched service: the provider's object when it is registered, nothing when it is unregistered. */
export type ServiceListener<Service> = (service: Service | undefined, change: ServiceChange) => void;

/** Hears a watched capability: the implementation that joined or left. */
export type ImplementationListener<Implementation> = (implementation: Implementation, change: ImplementationChange) => void;

/** A want's settlement, which the plugin may withdraw while it has not settled. */
export interface Want<Service> extends Promise<Service> {
  /**
   * Withdraws the want while it still waits, so the core never settles it and this promise never settles. Answers
   * false, withdrawing nothing, for a want that has settled already, its settlement still delivered, and for one
   * withdrawn already or never made.
   *
   * @throws DetachedError once the core has forgotten the plugin.
   */
  withdraw(): boolean;
}

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
  want<Service>(type: ServiceType<Service>, options?: WantOptions): Want<Service>;
  /** Hears every later registration and removal the core reports for the id, until the answered function is called. */
  watch<Service>(type: ServiceType<Service>, listener: ServiceListener<Service>): () => void;
  /**
   * The enums of the description that bound `service`, a definition this plugin got, `weivel_status` among them;
   * undefined for an object no description bound, as one a plugin registered.
   */
  enumsOf(service: unknown): DescribedEnums | undefined;
}

/** How a plugin sees the implementations of a capability: only those whose providers' activations were verified. */
export interface Capabilities {
  /** Every verified implementation now, in the order the core answers them. */
  all<Implementation>(type: CapabilityType<Implementation>): Implementation[];
  /** Hears every implementation that joins or leaves from now on, until the answered function is called. */
  watch<Implementation>(type: CapabilityType<Implementation>, listener: ImplementationListener<Implementation>): () => void;
  /**
   * The enums of the contract a loaded library publishes for the capability, `weivel_status` among them; undefined
   * while none is published.
   */
  enumsOf<Implementation>(type: CapabilityType<Implementation>): DescribedEnums | undefined;
}

/** Something this plugin held was withdrawn, so it must stop using it. */
export interface RevokedPluginEvent {
  readonly kind: "revoked";
  readonly reach: ReachKind;
  readonly id: string;
  readonly implementation: unknown;
  /**
   * Says this plugin no longer uses what was revoked, once it has let go of everything the object handed it. For a
   * registration made awaiting releases it ends the holding the core keeps, and the last such end tells the owner;
   * otherwise, and after the first call, it does nothing.
   *
   * @remarks The event object grants it: whoever this plugin hands the event or the function to ends the plugin's
   * holding by calling it. A call through the object after it, a C library's definition above all, is this plugin's
   * defect and undefined, as any use of memory after its free is: nothing keeps the binary open for it any more.
   */
  release(): void;
}

/** Every holding of a service this plugin registered awaiting releases has ended since it was unregistered. */
export interface HoldingsReleasedPluginEvent {
  readonly kind: "holdings-released";
  readonly id: string;
  /** The object it registered. */
  readonly service: unknown;
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
export type PluginEvent = RevokedPluginEvent | ReachRefusedPluginEvent | DegradedPluginEvent | HoldingsReleasedPluginEvent;

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
  /**
   * The enums and entries `names` asks for, read from what `enumsOf` answered, so a name the description lacks is
   * refused here rather than read as undefined.
   *
   * @throws TypeError naming the first enum or entry missing, `of` naming whose enums they are.
   */
  requireEnums<const Names extends EnumNames>(enums: DescribedEnums | undefined, names: Names, of: string): RequiredEnums<Names>;
  service<Service>(id: string): ServiceType<Service>;
  readonly services: Services;
}
