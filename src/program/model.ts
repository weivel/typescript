import type { Logger } from "../context/index.js";
import type { NativeValue } from "../host/index.js";
import type { HostMode, HostPluginState } from "../standard/index.js";

export interface RunHostOptions {
  /** The binary of the library that serves `weivel.host`; its declaration is the `library.json` beside it. */
  readonly hostLibraryPath: string;
  /** Handed to the host library's `start`, in order. */
  readonly arguments?: readonly string[];
  /** The run's stop request, honoured from the moment `start` answered OK. */
  readonly signal?: AbortSignal;
  /** The core's shared library; `native/` beside the package by default. */
  readonly coreLibraryPath?: string;
  /** The standard's shared library; `native/` beside the package by default. */
  readonly standardLibraryPath?: string;
  /** Where the program writes what went wrong and the core's logs; the console by default. */
  readonly log?: Logger;
  /** The export of each plugin's entry module that is the plugin; `default` by default. */
  readonly entryExport?: string;
}

/** Whether a text of the plan is set: neither NULL nor past the size the provider answered. */
export function isSet(text: string | null | undefined): text is string {
  return text !== undefined && text !== null;
}

/** The code the program exits with when `start` did not answer OK, or `stop` answered no code. */
export const failedRunExit = 1;

export interface PlannedLibrary {
  readonly binary: string;
  readonly declaration: string;
}

export interface PlannedPlugin {
  readonly directory: string;
  readonly manifest: string;
  readonly entry: string;
}

/**
 * A weivel_standard_host_plan as the bound `start` answers it: a NULL text is null, a NONE value is undefined, and a
 * member past the size the provider answered is left out.
 */
export interface HostPlan {
  readonly mode: HostMode;
  readonly libraries: readonly PlannedLibrary[];
  readonly plugins: readonly PlannedPlugin[];
  readonly action_plugin?: string | null;
  readonly action_name?: string | null;
  readonly action_arguments?: NativeValue;
  readonly action_service?: string | null;
  readonly action_method?: string | null;
}

/** A weivel_standard_host_outcome as the bound `started` takes it. */
export interface HostOutcome {
  readonly manifest: string;
  readonly state: HostPluginState;
  readonly detail: string | null;
}

/** How an ACTION run's action ended: the value it answered, `undefined` for nothing, or why it threw. */
export type ActionEnding = { readonly result: NativeValue | undefined } | { readonly failure: string };
