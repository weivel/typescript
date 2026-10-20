import type { AppDescriptor, HomeDescriptor, ManifestMarketplace, ManifestPublish, RepoMeta } from "./product.js";

/**
 * A capability id paired, in the type system, with the implementation that id requires.
 *
 * @remarks
 * The library that defines a category owns its key. This package deliberately mints none,
 * which is what lets the api be reused by a project that has never heard of this ecosystem.
 */
export interface CapabilityType<T> {
  /** Never present at run time. It exists so two keys parameterised differently cannot be interchanged. */
  readonly __phantom?: T;
  /** The id itself, which is what crosses the boundary at run time. */
  readonly id: string;
}

/**
 * A plugin's settings as it ships them.
 *
 * @remarks
 * Values only. What a setting is CALLED and how a surface renders it is the settings
 * capability's business, which this contract may not know: a manifest that carried labels would be
 * minting vocabulary, and the api mints none.
 */
export interface ManifestConfig {
  /** Every setting this plugin has, and what it is worth until a home changes it. */
  defaults: Record<string, unknown>;
  /**
   * The file these settings live in, `config/<name>.json`, when that is not the plugin's id.
   *
   * @remarks
   * Absent means the id, which is the case for all but a plugin whose settings file
   * predates its repository name. Stated rather than assumed, because a surface that guesses
   * writes to a file the plugin never reads.
   */
  name?: string;
}

/**
 * Everything a plugin may touch, and the only way it touches any of it.
 *
 * @remarks
 * Taking everything through the context is what makes the introspection ledger and the
 * doctor free rather than separately built, and it is the seam a host would use to run a plugin out
 * of process without changing plugin code.
 */
export interface PluginContext {
  /**
   * The typed key for a capability id, so a plugin can provide one without linking the library
   * that mints it.
   *
   * @remarks
   * The id is data the manifest already states, and the payload type comes from a
   * type-only import, which erases at build time. That pair is what makes a plugin's only runtime
   * dependency this package.
   */
  capability<T>(id: string): CapabilityType<T>;
  readonly config: PluginConfig;
  readonly events: Events;
  /**
   * Every app home the host knows about, whether or not each exists on disk.
   *
   * @remarks
   * Asked rather than held, because a home can appear, and can be installed, while a
   * plugin is running. `paths` is this plugin's own home; this is every home there is.
   */
  homes(): HomeDescriptor[];
  readonly host: HostDescriptor;
  readonly log: Logger;
  readonly manifest: PluginManifest;
  readonly paths: PluginPaths;
  /**
   * Supplies the implementation behind a capability the manifest declares.
   *
   * @remarks
   * One signature, never a plain-string overload beside it: the pair would let a wrong
   * payload compile through the string side.
   */
  provide<T>(type: CapabilityType<T>, implementation: T): void;
  /**
   * The typed key for a service id, so a plugin can reach another's API, or offer its own, without
   * linking the library that mints the id.
   *
   * @remarks
   * The counterpart of `capability` for the ids a manifest states under
   * `services`. Without it a plugin would have to write the key literal itself, which is the
   * plugin minting vocabulary rather than naming an id it already declares.
   */
  service<T>(id: string): ServiceType<T>;
  readonly services: Services;
  /**
   * The typed key for an event topic, so a plugin can publish or subscribe without linking the
   * library that names the topic.
   *
   * @remarks
   * Same reason as `service`: a topic is an id, and a plugin that had to
   * build the key by hand would be minting the vocabulary instead of naming it.
   */
  topic<T>(id: string): TopicType<T>;
}

/**
 * How a plugin reaches another plugin's API, and offers its own.
 *
 * @remarks
 * A typed handle, never an import: the plugin answering is whichever one registered the
 * id, so no plugin ever names another. This is what makes a plugin terminal, and it is the reason
 * a host needs no import of anything it drives.
 */
export interface Services {
  /** What is registered under this id right now, or absent when nothing is. */
  get<T>(type: ServiceType<T>): T | undefined;
  ids(): string[];
  /** Offers an implementation under this id, until the returned function is called. */
  register<T>(type: ServiceType<T>, implementation: T): () => void;
  /** Waits for the id to be registered, for a host default the implementation chooses. */
  want<T>(type: ServiceType<T>): Promise<T>;
  /** Waits for the id to be registered, giving up after the stated time. */
  want<T>(type: ServiceType<T>, options: WantOptions): Promise<T>;
  /**
   * Reports every registration and removal of this id until the returned function is called. The
   * listener is handed the service and either "register" or "unregister"; on the latter the
   * service is absent.
   *
   * @remarks
   * Distinct from `want`, which answers once: a service can be replaced while a
   * consumer is still holding the old one, and only a watcher sees that.
   */
  watch<T>(type: ServiceType<T>, listener: ((a: T, b: string) => void)): () => void;
}

/**
 * How a plugin says something happened, and hears that something did.
 *
 * @remarks
 * A topic is paired with its payload in the type system, so a publisher and a subscriber
 * cannot disagree about the shape without the compiler saying so.
 */
export interface Events {
  /** Says a topic carried this payload, to whoever is listening and to nobody in particular. */
  publish<T>(topic: TopicType<T>, payload: T): void;
  /** Hears this topic until the returned function is called. */
  subscribe<T>(topic: TopicType<T>, listener: ((value: T) => void)): () => void;
}

/**
 * Key/value store of JSON strings, keyed by file-like names. `update` must be atomic; that is
 * the implementation's concern.
 *
 * @remarks
 * The key examples this once carried named plugin categories, which the contract may not
 * know, and became visible to that gate the moment this interface started emitting TypeScript.
 */
export interface Store {
  /** Removes `key`, and does nothing when it holds nothing. */
  delete(key: string): void;
  exists(key: string): boolean;
  /** The value stored under `key`, or `null` when nothing is stored there. */
  get(key: string): string;
  /** Every key beginning with `prefix`, in the order the store holds them. */
  listKeys(prefix: string): string[];
  /** Stores `value` under `key`, replacing whatever was there. */
  put(key: string, value: string): void;
  /**
   * Replaces `key`'s value with what `mutator` returns, reading and writing as one
   * step, and hands the mutator `null` when the key holds nothing yet.
   */
  update(key: string, mutator: ((value: string) => string)): void;
}

/**
 * One slash command a plugin contributes, declared rather than registered by running code.
 *
 * @remarks
 * Declared so a host can deploy a plugin's commands without importing it, which is what
 * lets the command files exist before the plugin has ever activated.
 */
export interface ManifestCommand {
  /** The argument shape a picker hints at, such as `list | get <key>`. */
  argumentHint?: string;
  /** Markdown the model is shown, after any shell output. */
  body?: string;
  description: string;
  /** The command's name, which is also the file it is written to. */
  name: string;
  /** A shell line run before the body, which may use $ARGUMENTS and {{BUNDLE}}. */
  shell?: string;
}

/**
 * The absolute storage directories of the app home a plugin is running in.
 *
 * @remarks
 * A plugin joins paths onto these rather than assembling a home path itself, so a renamed
 * directory takes effect everywhere at once.
 */
export interface PluginPaths {
  cache: string;
  config: string;
  home: string;
  plugin: string;
  repos: string;
}

/**
 * The contents of a repo's plugin.json.
 *
 * @remarks
 * No index signature and no additionalProperties: an author gets excess-property checking
 * while writing one, and the runtime validator still ignores fields it does not know, so a manifest
 * written against a later version loads on today's host.
 */
export interface PluginManifest {
  /**
   * Pointer at the published manifest schema, for an editor's completion and validation.
   *
   * @remarks
   * Declared although nothing reads it, because every manifest in the ecosystem carries
   * it and the published schema accepts it: without it an author writing a manifest literal in
   * TypeScript could not include a field their own plugin.json has.
   */
  $schema?: string;
  /** The lowest API major version this plugin needs. A floor, not a build tag. */
  api: number;
  /**
   * The app this repo is the loader for, declared by the app's own project.
   *
   * @remarks
   * Present only on a repo that IS an app's loader, which is what makes "whose loader is
   * this" answerable from the manifest alone, with no consumer naming a plugin.
   */
  app?: AppDescriptor;
  /** Host-facing abilities this plugin provides at activation, declared statically so a host can answer what it can do without executing it. */
  capabilities?: string[];
  /** Slash commands this plugin contributes, which a host deploys without importing it. */
  commands?: ManifestCommand[];
  config?: ManifestConfig;
  /** Where this plugin keeps state that is not named after it. */
  data?: ManifestData;
  displayName?: string;
  /** The built module a host imports. Required once `capabilities` is non-empty. */
  entry?: string;
  /** Path to a square-viewBox SVG mark, relative to the repo root. */
  icon?: string;
  /**
   * Further marks this repo ships, each keyed by the id of the thing it belongs to.
   *
   * @remarks
   * One repo can contribute several named things, and a single repo-level `icon`
   * cannot serve them. Keyed by id rather than by kind, so this package carries the marks without
   * learning what any of the ids name.
   */
  icons?: Record<string, string>;
  /** The plugin's permanent identity, matching its repository name. */
  id: string;
  lifecycle?: ManifestLifecycle;
  marketplace?: ManifestMarketplace;
  /** Declared permissions, surfaced at install and in dashboards. Not sandbox-enforced. */
  permissions?: string[];
  publish?: ManifestPublish;
  repo?: RepoMeta;
  services?: ManifestServices;
  /**
   * The applications this artifact is for. Absent means every application.
   *
   * @remarks
   * An artifact narrows itself deliberately and is never narrowed by omission, which is
   * what keeps this additive: every manifest written before the field existed stays loadable
   * everywhere. A host refuses only when both sides name applications and the two sets are
   * disjoint.
   */
  targets?: string[];
}

/**
 * What a plugin may know about its host.
 *
 * @remarks
 * Deliberately not a plugin registry: a plugin adapts to which surfaces exist, never to
 * which app it happens to be in.
 */
export interface HostDescriptor {
  /** The API major version this host implements. */
  api: number;
  app: string;
  /** Surface ids this host renders, for example `tui` or `gui`. An unknown id is ignored. */
  surfaces: string[];
}

/**
 * What a plugin offers other plugins, and what it asks of them.
 *
 * @remarks
 * Each entry may be written either way, as the bare service id or as the object form that
 * says more about it, so the Java element type is `Object` and the emitted one is the union.
 * Every manifest written before the object form stays valid and keeps its meaning, which is what
 * makes the widening additive rather than a new version of the vocabulary.
 */
export interface ManifestServices {
  /**
   * Services this plugin asks for, used for activation ordering and for what an absence costs,
   * written as bare ids or as {@link ManifestRequirement} objects.
   */
  consumes?: (string | ManifestRequirement)[];
  /**
   * Services this plugin registers, each namespaced by its own id or a well-known bare id,
   * written as bare ids or as {@link ManifestOffer} objects.
   */
  provides?: (string | ManifestOffer)[];
}

/**
 * What a plugin's entry module exports.
 *
 * @remarks
 * Each hook is awaited individually by the host under its own timeout, so a plugin that
 * throws or hangs is quarantined on its own rather than taking a host or a sibling with it.
 */
export interface Plugin {
  /** Supplies the implementation behind every capability the manifest declares. */
  activate(context: PluginContext): void | Promise<void>;
  /** Releases whatever `activate` took: timers, watchers, child processes. */
  deactivate(): void | Promise<void>;
  /** Runs once after the first deploy. */
  install?(context: PluginContext): void | Promise<void>;
  /** Runs on demand from a host, to put a broken installation right. */
  repair?(context: PluginContext): void | Promise<void>;
}

/**
 * Where a component writes what happened.
 *
 * @remarks
 * The host decides where the lines go, whether they mirror to a console, and how they are
 * attributed, so a component never opens a log file itself.
 */
export interface Logger {
  debug(message: string): void;
  error(message: string): void;
  error(message: string, cause: unknown): void;
  info(message: string): void;
  /** Something unexpected that did not stop the operation. */
  warn(message: string): void;
}

/**
 * Where a plugin keeps state that is not named after it.
 *
 * @remarks
 * A surface finds most of what a plugin leaves behind by its id; this is the escape hatch
 * for a plugin that writes elsewhere. Declared rather than asked for, because the surface that needs
 * it most is an uninstall, where the plugin is on its way out and may not be running at all.
 */
export interface ManifestData {
  /** Paths this plugin writes to, relative to the home it runs in. */
  paths: string[];
}

/** A service id paired, in the type system, with the contract that id promises. */
export interface ServiceType<T> {
  /** Never present at run time. It exists so two keys parameterised differently cannot be interchanged. */
  readonly __phantom?: T;
  /** The id itself, which is what crosses the boundary at run time. */
  readonly id: string;
}

/** An event topic paired, in the type system, with the payload it carries. */
export interface TopicType<T> {
  /** Never present at run time. It exists so two keys parameterised differently cannot be interchanged. */
  readonly __phantom?: T;
  /** The id itself, which is what crosses the boundary at run time. */
  readonly id: string;
}

/** How long a plugin is willing to wait for a service that is not registered yet. */
export interface WantOptions {
  /** Milliseconds to wait before giving up. Absent takes the host's own default. */
  timeoutMs?: number;
}

/** One plugin's configuration, already resolved by the host. */
export interface PluginConfig {
  /** Every setting, defaults merged with what is on disk. */
  all(): Record<string, unknown>;
  /** One setting, absent when it is neither set nor defaulted. */
  get<T>(key: string): T | undefined;
  /**
   * Writes one setting.
   *
   * @remarks
   * Asynchronous even where a host implements it synchronously, because the seam has to
   * survive a host that runs the plugin out of process.
   */
  set(key: string, value: unknown): Promise<void>;
}

/** One service a plugin asks for, and what its absence or its shortfall costs. */
export interface ManifestRequirement {
  /**
   * What this plugin needs of the service, keyed by constraint name, compared against what the
   * service advertises.
   */
  constraints?: Record<string, number>;
  /**
   * Whether this plugin accepts a service that never satisfies its constraints once the budget is
   * spent. Absent means false, and it never excuses an absence.
   */
  degradable?: boolean;
  id: string;
  /**
   * Whether this plugin still starts when nothing provides the service. Absent means true, which
   * is what writing the bare id means.
   */
  optional?: boolean;
}

/** One service a plugin registers, with what it claims before it is running to answer for itself. */
export interface ManifestOffer {
  /** What this service claims, keyed by attribute name, until the live service reports its own. */
  attributes?: Record<string, number>;
  id: string;
}

/** Which optional lifecycle hooks the entry module exports. */
export interface ManifestLifecycle {
  /** The entry exports `install(ctx)`, run once after the first deploy. */
  install?: boolean;
  /** The entry exports `repair(ctx)`, run on demand from a host. */
  repair?: boolean;
}
