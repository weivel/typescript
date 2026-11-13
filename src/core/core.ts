import { existsSync } from "node:fs";
import { join } from "node:path";
import koffi from "koffi";
import {
  readActivationPlan,
  readCapabilityList,
  readLedgerRow,
  readLedgerSnapshot,
  readServiceList,
  readSupport,
  type ActivationPlan,
  type CapabilityImplementation,
  type LedgerRow,
  type LedgerSnapshot,
  type Support,
} from "./answers.js";
import { Status, type EdgeSource, type HandleCondition } from "./constants.js";
import { bindCoreFunctions, coreStructs, type CoreFunctions, type CoreStructName } from "./declarations.js";
import { copyEvent, type CoreEvent } from "./events.js";
import { sharedLibraryFileName } from "./library-file.js";
import { allocateSized, toBigInt } from "./memory.js";
import {
  encodeCapacity,
  encodeCoreOptions,
  encodeManifest,
  encodePluginOptions,
  encodeQuarantineReason,
  encodeStrings,
  encodeWantOptions,
  type CapacityAnswer,
  type CoreOptions,
  type Manifest,
  type QuarantineReason,
  type WantOptions,
} from "./values.js";

/** What one bound call answered: its status, the events drained after it, and its value when it has one. */
export interface CallResult<Value> {
  readonly status: Status;
  readonly events: readonly CoreEvent[];
  readonly value: Value | undefined;
}

/** Receives every drained event, in the order the core queued them, never re-entered. */
export type EventDispatcher = (event: CoreEvent) => void;

/** Called once the events of a call, and of every call made while dispatching them, have all been dispatched. */
export type DrainListener = () => void;

/**
 * Receives what a dispatcher, a drain listener or a timer-driven call threw, with the event being dispatched when
 * there was one.
 *
 * @remarks No such error ever reaches the caller of a bound call: a caller handed an exception instead of the
 * plugin or registration it asked for could never release it, and a drain driven by a timer would kill the process.
 */
export type ListenerErrorSink = (error: unknown, event: CoreEvent | undefined) => void;

export const defaultListenerErrorSink: ListenerErrorSink = (error, event) => {
  console.error(`weivel: a listener threw${event === undefined ? "" : ` on a ${event.kind} event`}`, error);
};

export interface CoreLibrary {
  readonly path: string;
  readonly functions: CoreFunctions;
}

/** The core library the package's own build leaves in `native/` beside it. */
export function defaultCoreLibraryPath(): string {
  return join(import.meta.dirname, "..", "..", "native", sharedLibraryFileName("weivel_core"));
}

const loadedLibraries = new Map<string, CoreLibrary>();

/** Loads and binds the core library at `path`, once per path. */
export function loadCoreLibrary(path: string = defaultCoreLibraryPath()): CoreLibrary {
  const loaded = loadedLibraries.get(path);
  if (loaded !== undefined) {
    return loaded;
  }
  if (!existsSync(path)) {
    throw new Error(
      `The weivel core library is not at ${path}. Build it with \`node scripts/native.ts\`, or pass the path of a built one.`,
    );
  }
  const library: CoreLibrary = { path, functions: bindCoreFunctions(koffi.load(path)) };
  loadedLibraries.set(path, library);
  return library;
}

export interface CreateCoreOptions {
  readonly library?: CoreLibrary;
  readonly libraryPath?: string;
  readonly options?: CoreOptions;
  readonly dispatcher?: EventDispatcher;
  readonly onListenerError?: ListenerErrorSink;
}

/** Creates a core; a status other than OK answers no core, and no core exists to queue a refusal for it. */
export function createCore(createOptions: CreateCoreOptions = {}): CallResult<Core> {
  const library = createOptions.library ?? loadCoreLibrary(createOptions.libraryPath);
  const created: unknown[] = [null];
  const options = createOptions.options === undefined ? null : encodeCoreOptions(createOptions.options);
  const status = library.functions.weivel_core_create(options, created, null) as Status;
  if (status !== Status.Ok) {
    return { status, events: [], value: undefined };
  }
  const core = new Core(library.functions, created[0] as object, createOptions.onListenerError);
  if (createOptions.dispatcher !== undefined) {
    core.setDispatcher(createOptions.dispatcher);
  }
  return { status, events: [], value: core };
}

type Release = (answer: object) => number;

/** Reads an answer and releases it, released whatever the read does. */
export function readThenRelease<Value>(answer: object, read: (answer: object) => Value, release: Release): Value {
  try {
    return read(answer);
  } finally {
    release(answer);
  }
}

type EventCopier = (event: object) => CoreEvent | undefined;

/**
 * Moves every queued event into `drained` until the core answers NONE: the only caller of weivel_next_event. Each
 * event is released whatever copying it does, so the next weivel_next_event never meets an unreleased event, and an
 * event that cannot be copied goes to `report` while the rest are still drained.
 */
export function drainEvents(
  functions: CoreFunctions,
  core: object,
  eventBuffer: object,
  drained: CoreEvent[],
  copy: EventCopier,
  report: ListenerErrorSink,
): void {
  for (;;) {
    const status = functions.weivel_next_event(core, eventBuffer, null) as Status;
    if (status === Status.None) {
      return;
    }
    if (status !== Status.Ok) {
      throw new Error(`weivel_next_event answered status ${status}: the layer's event struct is malformed.`);
    }
    try {
      const event = copy(eventBuffer);
      if (event !== undefined) {
        drained.push(event);
      }
    } catch (error) {
      report(error, undefined);
    } finally {
      functions.weivel_event_release(eventBuffer);
    }
  }
}

function allocateZeroed(name: CoreStructName): object {
  return allocateSized(coreStructs[name]);
}

/**
 * One core, every call to which goes through one function that makes the call and then drains the event queue.
 *
 * @remarks Events are copied and released as they are drained, then dispatched after the whole queue is empty, so a
 * call the dispatcher makes drains its own events, which are dispatched after the event being dispatched. The
 * dispatcher is therefore never re-entered and sees every event in the core's order.
 */
export class Core {
  readonly #functions: CoreFunctions;
  readonly #event: object;
  #core: object | null;
  #dispatcher: EventDispatcher | undefined;
  readonly #drainListeners = new Set<DrainListener>();
  readonly #undispatched: CoreEvent[] = [];
  #settling = false;
  readonly #onListenerError: ListenerErrorSink;

  constructor(functions: CoreFunctions, core: object, onListenerError: ListenerErrorSink = defaultListenerErrorSink) {
    this.#functions = functions;
    this.#core = core;
    this.#onListenerError = onListenerError;
    this.#event = allocateZeroed("weivel_event");
  }

  /** Hands an error to the core's listener error sink; a sink that throws is reported to the console instead. */
  reportListenerError(error: unknown, event?: CoreEvent): void {
    try {
      this.#onListenerError(error, event);
    } catch (sinkError) {
      defaultListenerErrorSink(sinkError, event);
    }
  }

  setDispatcher(dispatcher: EventDispatcher | undefined): void {
    this.#dispatcher = dispatcher;
  }

  /** Adds a listener told after every drain; the answer removes it. */
  addDrainListener(listener: DrainListener): () => void {
    this.#drainListeners.add(listener);
    return () => this.#drainListeners.delete(listener);
  }

  get destroyed(): boolean {
    return this.#core === null;
  }

  destroy(): void {
    if (this.#core === null) {
      return;
    }
    this.#functions.weivel_core_destroy(this.#core);
    this.#core = null;
    koffi.free(this.#event);
  }

  nextDeadline(): CallResult<number> {
    const deadline: unknown[] = [0];
    return this.#invoke(
      (core) => this.#functions.weivel_next_deadline(core, deadline, null),
      () => Number(deadline[0]),
    );
  }

  advance(now: number): CallResult<undefined> {
    return this.#invoke((core) => this.#functions.weivel_advance(core, now, null));
  }

  supports(manifest: Manifest): CallResult<Support> {
    return this.#invokeWithAnswer(
      "weivel_support",
      (core, answer) => this.#functions.weivel_supports(core, encodeManifest(manifest), answer, null),
      readSupport,
      (answer) => this.#functions.weivel_support_release(answer),
    );
  }

  registerManifest(manifest: Manifest): CallResult<bigint> {
    return this.#invokeForHandle((core, handle) =>
      this.#functions.weivel_register_manifest(core, encodeManifest(manifest), handle, null),
    );
  }

  planActivation(plugins: readonly bigint[], edgeSource: EdgeSource, hostProvided?: readonly string[]): CallResult<ActivationPlan> {
    const pluginList = plugins.length === 0 ? null : [...plugins];
    const provided = hostProvided === undefined ? null : encodeStrings(hostProvided);
    return this.#invokeWithAnswer(
      "weivel_activation_plan",
      (core, answer) =>
        this.#functions.weivel_plan_activation(core, pluginList, plugins.length, edgeSource, provided, answer, null),
      readActivationPlan,
      (answer) => this.#functions.weivel_activation_plan_release(answer),
    );
  }

  openPlugin(plugin: bigint, payload?: bigint): CallResult<undefined> {
    const options = payload === undefined ? null : encodePluginOptions(payload);
    return this.#invoke((core) => this.#functions.weivel_open_plugin(core, plugin, options, null));
  }

  pluginPayload(plugin: bigint): CallResult<bigint> {
    return this.#invokeForHandle((core, payload) => this.#functions.weivel_plugin_payload(core, plugin, payload, null));
  }

  releasePlugin(plugin: bigint): CallResult<undefined> {
    return this.#invoke((core) => this.#functions.weivel_release_plugin(core, plugin, null));
  }

  quarantinePlugin(plugin: bigint, reason?: QuarantineReason): CallResult<undefined> {
    const encoded = reason === undefined ? null : encodeQuarantineReason(reason);
    return this.#invoke((core) => this.#functions.weivel_quarantine_plugin(core, plugin, encoded, null));
  }

  forgetPlugin(plugin: bigint): CallResult<undefined> {
    return this.#invoke((core) => this.#functions.weivel_forget_plugin(core, plugin, null));
  }

  registerService(owner: bigint, id: string): CallResult<bigint> {
    return this.#invokeForHandle((core, handle) => this.#functions.weivel_register_service(core, owner, id, handle, null));
  }

  unregister(handle: bigint): CallResult<undefined> {
    return this.#invoke((core) => this.#functions.weivel_unregister(core, handle, null));
  }

  handleState(handle: bigint): CallResult<HandleCondition> {
    const condition: unknown[] = [0];
    return this.#invoke(
      (core) => this.#functions.weivel_handle_state(core, handle, condition, null),
      () => condition[0] as HandleCondition,
    );
  }

  getService(plugin: bigint, id: string): CallResult<bigint> {
    return this.#invokeForHandle((core, handle) => this.#functions.weivel_get_service(core, plugin, id, handle, null));
  }

  wantService(plugin: bigint, id: string, options?: WantOptions): CallResult<bigint> {
    const encoded = options === undefined ? null : encodeWantOptions(options);
    return this.#invokeForHandle((core, handle) =>
      this.#functions.weivel_want_service(core, plugin, id, encoded, handle, null),
    );
  }

  reportCapacity(want: bigint, registration: bigint, answer: CapacityAnswer, now: number): CallResult<undefined> {
    const encoded = encodeCapacity(answer);
    return this.#invoke((core) => this.#functions.weivel_report_capacity(core, want, registration, encoded, now, null));
  }

  watchService(plugin: bigint, id: string): CallResult<bigint> {
    return this.#invokeForHandle((core, handle) => this.#functions.weivel_watch_service(core, plugin, id, handle, null));
  }

  serviceIds(plugin: bigint): CallResult<string[]> {
    return this.#invokeForServiceList((core, answer) => this.#functions.weivel_service_ids(core, plugin, answer, null));
  }

  unboundServices(plugin: bigint): CallResult<string[]> {
    return this.#invokeForServiceList((core, answer) =>
      this.#functions.weivel_unbound_services(core, plugin, answer, null),
    );
  }

  provideCapability(plugin: bigint, id: string): CallResult<bigint> {
    return this.#invokeForHandle((core, handle) =>
      this.#functions.weivel_provide_capability(core, plugin, id, handle, null),
    );
  }

  verifyActivation(plugin: bigint): CallResult<undefined> {
    return this.#invoke((core) => this.#functions.weivel_verify_activation(core, plugin, null));
  }

  allCapabilities(plugin: bigint, id: string): CallResult<CapabilityImplementation[]> {
    return this.#invokeWithAnswer(
      "weivel_capability_list",
      (core, answer) => this.#functions.weivel_all_capabilities(core, plugin, id, answer, null),
      readCapabilityList,
      (answer) => this.#functions.weivel_capability_list_release(answer),
    );
  }

  watchCapability(plugin: bigint, id: string): CallResult<bigint> {
    return this.#invokeForHandle((core, handle) =>
      this.#functions.weivel_watch_capability(core, plugin, id, handle, null),
    );
  }

  ledger(): CallResult<LedgerSnapshot> {
    return this.#invokeWithAnswer(
      "weivel_ledger_snapshot",
      (core, answer) => this.#functions.weivel_ledger(core, answer, null),
      readLedgerSnapshot,
      (answer) => this.#functions.weivel_ledger_snapshot_release(answer),
    );
  }

  ledgerEntry(plugin: bigint): CallResult<LedgerRow> {
    return this.#invokeWithAnswer(
      "weivel_ledger_row",
      (core, answer) => this.#functions.weivel_ledger_entry(core, plugin, answer, null),
      readLedgerRow,
      (answer) => this.#functions.weivel_ledger_row_release(answer),
    );
  }

  #invokeForHandle(call: (core: object, handle: unknown[]) => number): CallResult<bigint> {
    const handle: unknown[] = [0];
    return this.#invoke(
      (core) => call(core, handle),
      () => toBigInt(handle[0]),
    );
  }

  #invokeForServiceList(call: (core: object, answer: object) => number): CallResult<string[]> {
    return this.#invokeWithAnswer("weivel_service_list", call, readServiceList, (answer) =>
      this.#functions.weivel_service_list_release(answer),
    );
  }

  #invokeWithAnswer<Value>(
    answerStruct: CoreStructName,
    call: (core: object, answer: object) => number,
    read: (answer: object) => Value,
    release: Release,
  ): CallResult<Value> {
    const answer = allocateZeroed(answerStruct);
    try {
      return this.#invoke(
        (core) => call(core, answer),
        () => readThenRelease(answer, read, release),
      );
    } finally {
      koffi.free(answer);
    }
  }

  /**
   * The one function every call taking a core goes through: it makes the call, reads the call's value when the
   * status is OK, drains the queue, and dispatches what it drained. The drain runs whatever the call or the read
   * throws, so a call's events always belong to it.
   */
  #invoke<Value>(call: (core: object) => number, readValue?: () => Value): CallResult<Value> {
    const core = this.#liveCore();
    const events: CoreEvent[] = [];
    try {
      const status = call(core) as Status;
      const value = status === Status.Ok ? readValue?.() : undefined;
      return { status, events, value };
    } finally {
      this.#drainAndSettle(core, events);
    }
  }

  #drainAndSettle(core: object, events: CoreEvent[]): void {
    try {
      drainEvents(this.#functions, core, this.#event, events, copyEvent, (error, event) =>
        this.reportListenerError(error, event),
      );
    } finally {
      this.#undispatched.push(...events);
      this.#settle();
    }
  }

  #liveCore(): object {
    if (this.#core === null) {
      throw new Error("This weivel core was destroyed; no call can be made on it.");
    }
    return this.#core;
  }

  #settle(): void {
    if (this.#settling) {
      return;
    }
    this.#settling = true;
    try {
      do {
        this.#dispatchUndispatched();
        this.#notifyDrainListeners();
      } while (this.#undispatched.length > 0);
    } finally {
      this.#settling = false;
    }
  }

  #dispatchUndispatched(): void {
    for (let event = this.#undispatched.shift(); event !== undefined; event = this.#undispatched.shift()) {
      try {
        this.#dispatcher?.(event);
      } catch (error) {
        this.reportListenerError(error, event);
      }
    }
  }

  #notifyDrainListeners(): void {
    for (const listener of [...this.#drainListeners]) {
      try {
        listener();
      } catch (error) {
        this.reportListenerError(error);
      }
    }
  }
}
