import type { ActivationPlan, CoreOptions, EdgeSource, ListenerErrorSink, Manifest, Refusal } from "../core/index.js";
import type { Logger, PluginContext } from "../context/index.js";
import type { LibraryDeclaration } from "../standard/answers.js";
import type { Clock, Scheduler, TimerMoveListener } from "../timer/index.js";

/**
 * A plugin's entry as the host's caller hands it to `register`: in TypeScript, an object whose `activate` takes the
 * plugin's context and may finish later, and whose optional `deactivate` may finish later too.
 */
export interface Plugin {
  /** Supplies the implementation behind every capability the manifest declares. */
  activate(context: PluginContext): void | Promise<void>;
  /** Releases whatever `activate` took: timers, watchers, child processes. */
  deactivate?(): void | Promise<void>;
}

export interface HostOptions {
  /** Which declarations order activation; the core has no default, so the host's caller chooses. */
  readonly edgeSource: EdgeSource;
  /** The core's shared library; `native/` beside the package by default. */
  readonly coreLibraryPath?: string;
  /** Handed to weivel_core_create unchanged. */
  readonly core?: CoreOptions;
  /** The time handed to the core; the timer's clock by default. */
  readonly clock?: Clock;
  /**
   * Arms the core's next deadline; `setTimeout` by default.
   *
   * @remarks The default timer is not unref'd, so a want waiting on time keeps Node alive until it settles.
   */
  readonly scheduler?: Scheduler;
  /** Told of every move the host's timer makes, as the core announces its deadline. */
  readonly onTimerMove?: TimerMoveListener;
  /** Where the core's logs and what goes wrong in the host's own objects go; the console by default. */
  readonly log?: Logger;
  /** The log a plugin's context forwards to; the host's log by default. */
  readonly pluginLog?: (manifest: Manifest) => Logger;
  /** Where an error thrown by code the layer calls goes; the wrapper's default by default. */
  readonly onListenerError?: ListenerErrorSink;
}

/** A plugin the core registered for this host, with the entry its caller handed in. */
export interface HostedPlugin {
  readonly plugin: bigint;
  readonly manifest: Manifest;
  readonly entry: Plugin;
}

/** The answer to registering a plugin: its handle, or the core's refusal. */
export type RegisterAnswer =
  | { readonly plugin: bigint; readonly refusal: undefined }
  | { readonly plugin: undefined; readonly refusal: Refusal };

/**
 * Where an activation ended: `refused` when the core refused to open the plugin, `released` for a plugin released
 * before its activate settled, `failed` when its open failed for a reason other than the core's refusal.
 */
export type ActivationState = "active" | "quarantined" | "refused" | "released" | "failed";

/** Where one plugin's activation ended, and why when it did not end active. */
export interface ActivationOutcome {
  readonly plugin: bigint;
  readonly importName: string;
  readonly state: ActivationState;
  /** For a quarantined plugin, the reason its ledger row shows; for a refused one, the core's refusal. */
  readonly refusal: Refusal | undefined;
}

/** What `activate` answers once every activate has been started, before any has settled. */
export interface ActivationStart {
  /** The core's plan, cycles and refusals included, exactly as answered; its order is the order activates started. */
  readonly plan: ActivationPlan;
  /** One outcome per plugin of the plan's order, in that order, once every activate has settled. */
  readonly outcomes: Promise<readonly ActivationOutcome[]>;
}

/** What every call on a destroyed host answers, as a value: it neither throws nor writes anywhere. */
export interface HostDestroyed {
  readonly destroyed: true;
}

export const hostDestroyed: HostDestroyed = Object.freeze({ destroyed: true });

export function isHostDestroyed(answer: unknown): answer is HostDestroyed {
  return answer === hostDestroyed;
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
