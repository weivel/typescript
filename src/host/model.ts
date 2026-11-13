import type {
  ActivationPlan,
  CoreOptions,
  EdgeSource,
  ListenerErrorSink,
  Manifest,
  Refusal,
  Support,
} from "../core/index.js";
import type { Logger, PluginContext } from "../context/index.js";
import type { DiscoveryFailure, LibraryDeclaration, StandardRefusal } from "../standard/index.js";
import type { Clock, Scheduler } from "../timer/index.js";

/** What a plugin's entry module exports as its default. */
export interface Plugin {
  /** Supplies the implementation behind every capability the manifest declares. */
  activate(context: PluginContext): void | Promise<void>;
  /** Releases whatever `activate` took: timers, watchers, child processes. */
  deactivate(): void | Promise<void>;
}

export interface HostOptions {
  /** Which declarations order activation; the core has no default, so the host's caller chooses. */
  readonly edgeSource: EdgeSource;
  /** The core's shared library; `native/` beside the package by default. */
  readonly coreLibraryPath?: string;
  /** The standard's shared library; `native/` beside the package by default. */
  readonly standardLibraryPath?: string;
  /** Handed to weivel_core_create unchanged; its well-known services are also handed to discovery. */
  readonly core?: CoreOptions;
  /** The time handed to the core; the timer's clock by default. */
  readonly clock?: Clock;
  /**
   * Arms the core's next deadline; `setTimeout` by default.
   *
   * @remarks The default timer is not unref'd, so a want waiting on time keeps Node alive until it settles.
   */
  readonly scheduler?: Scheduler;
  /** Where the core's logs and what goes wrong in the host's own objects go; the console by default. */
  readonly log?: Logger;
  /** The log a plugin's context forwards to; the host's log by default. */
  readonly pluginLog?: (manifest: Manifest) => Logger;
  /** Where an error thrown by a listener the core wrapper calls goes; the wrapper's default by default. */
  readonly onListenerError?: ListenerErrorSink;
}

/** A plugin the core registered for this host, and where its entry module is. */
export interface HostedPlugin {
  readonly plugin: bigint;
  readonly manifest: Manifest;
  readonly manifestPath: string;
  /** The entry the standard resolved against the plugin's directory; null when the manifest names none. */
  readonly entryPath: string | null;
}

/** A discovered plugin the core answered this host cannot load, with the core's answer as it stands. */
export interface UnsupportedPlugin {
  readonly manifestPath: string;
  readonly manifest: Manifest;
  readonly support: Support;
}

/** A discovered plugin the core refused to register. */
export interface RefusedPlugin {
  readonly manifestPath: string;
  readonly manifest: Manifest;
  readonly refusal: Refusal;
}

export interface DiscoveryReport {
  /** The standard's refusal of the directory itself; every list is then empty. */
  readonly refusal: StandardRefusal | undefined;
  readonly registered: readonly HostedPlugin[];
  readonly unsupported: readonly UnsupportedPlugin[];
  readonly refused: readonly RefusedPlugin[];
  /** Every file the standard could not take a plugin from. */
  readonly failures: readonly DiscoveryFailure[];
}

export type ActivationState = "active" | "quarantined" | "refused";

/** Where one plugin's activation ended, and why when it did not end active. */
export interface ActivationOutcome {
  readonly plugin: bigint;
  readonly importName: string;
  readonly state: ActivationState;
  /** For a quarantined plugin, the reason its ledger row shows; for a refused one, the core's refusal. */
  readonly refusal: Refusal | undefined;
}

export interface ActivationReport {
  /** The core's plan, cycles and refusals included, exactly as answered. */
  readonly plan: ActivationPlan;
  /** One outcome per plugin of the plan's order, in that order. */
  readonly outcomes: readonly ActivationOutcome[];
}

/** A C library bound as host services. */
export interface LoadedLibrary {
  readonly declaration: LibraryDeclaration;
  /** Each declared service's object, by id, as registered under the host: a method per declared function. */
  readonly services: ReadonlyMap<string, LibraryService>;
  /** Unregisters every service and unloads the library. */
  unload(): void;
}

/** A bytes function of a C library: the bytes handed in, the bytes it answered out. */
export type LibraryFunction = (input: Uint8Array) => Uint8Array;

export type LibraryService = Readonly<Record<string, LibraryFunction>>;

/** The answer to loading a library: the library, or the standard's or the layer's refusal of its declaration. */
export type LibraryAnswer =
  | { readonly library: LoadedLibrary; readonly refusal: undefined }
  | { readonly library: undefined; readonly refusal: StandardRefusal };
