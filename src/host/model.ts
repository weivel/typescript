import type { ActivationPlan, CoreOptions, EdgeSource, ListenerErrorSink, Manifest, Refusal } from "../core/index.js";
import type { Logger, PluginContext } from "../context/index.js";
import type { LibraryDeclaration } from "../standard/answers.js";
import type { BoundDefinition } from "./description/definition.js";
import type { NativeValue } from "./description/values.js";
import type { DescriptionCheck, LibraryDefinition } from "./libraries.js";
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
  /** What the plugin offers to run once, by name, as a host program's ACTION run asks for one. */
  readonly actions?: Readonly<Record<string, PluginAction>>;
}

/**
 * One action of a plugin: it takes the run's arguments, `undefined` when there are none, and answers a value tree,
 * or `undefined` for nothing, at once or as a promise.
 */
export type PluginAction = (actionArguments: NativeValue | undefined) => NativeValue | undefined | Promise<NativeValue | undefined>;

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
  /**
   * Checks each description a library declares before the host binds it: the standard's
   * `(description) => standard.checkDescription(description)`. A host given none refuses a library that declares one.
   */
  readonly descriptionCheck?: DescriptionCheck;
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
  /** Undefined only for a verification the caller asked for of a handle the host never registered. */
  readonly importName: string | undefined;
  readonly state: ActivationState;
  /**
   * The refusal that decided it: for a refused plugin, the core's refusal of the open; for one quarantined because the
   * core refused its verification, that refusal; none for one quarantined for a reason of the host's, such as an
   * activate that failed, whose reason its ledger row keeps.
   */
  readonly refusal: Refusal | undefined;
}

/**
 * What `activate` answers once every activate has been started, before any has settled: the plan and its outcomes,
 * or, for a plan the core refused, that refusal and nothing started.
 */
export type ActivationStart =
  | {
      /** The core's plan, cycles and refusals included, exactly as answered; its order is the order activates started. */
      readonly plan: ActivationPlan;
      /** One outcome per plugin of the plan's order, in that order, once every activate has settled. */
      readonly outcomes: Promise<readonly ActivationOutcome[]>;
      readonly refusal: undefined;
    }
  | { readonly plan: undefined; readonly outcomes: undefined; readonly refusal: Refusal };

/** What every call on a destroyed host answers, as a value: it neither throws nor writes anywhere. */
export interface HostDestroyed {
  readonly destroyed: true;
}

export const hostDestroyed: HostDestroyed = Object.freeze({ destroyed: true });

export function isHostDestroyed(answer: unknown): answer is HostDestroyed {
  return answer === hostDestroyed;
}

/** How `Host.loadLibrary` binds a C library. */
export interface LoadLibraryOptions {
  /**
   * Ids of the declaration that are bound but registered for no plugin: the caller reaches each through the loaded
   * library alone, and the binary's close does not wait on one.
   */
  readonly withheld?: readonly string[];
}

/** A C library bound as host services. */
export interface LoadedLibrary {
  readonly declaration: LibraryDeclaration;
  /** Each service of bytes functions, by id, as bound, registered under the host unless withheld: a method per function. */
  readonly services: ReadonlyMap<string, LibraryService>;
  /**
   * Each definition service, by id, as bound, registered under the host unless withheld.
   *
   * @remarks This hands the caller the raw address of each struct, and the caller holds no registration of it, so its
   * use keeps nothing open: the address dies with the binary, which closes once every holder has released it after
   * the unload, or once the host is destroyed.
   */
  readonly definitions: ReadonlyMap<string, LibraryDefinition>;
  /** Each definition service that declares a description, by id, as the bound object, registered unless withheld. */
  readonly described: ReadonlyMap<string, BoundDefinition>;
  /**
   * Unregisters every service at once and refuses every later bytes call; the binary closes once every holding of
   * each definition has been released, as each holder's `release` of its revocation says.
   */
  unload(): void;
}

/** A bytes function of a C library: the bytes handed in, the bytes it answered out. */
export type LibraryFunction = (input: Uint8Array) => Uint8Array;

export type LibraryService = Readonly<Record<string, LibraryFunction>>;
