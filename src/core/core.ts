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
 * Called once an outermost call has settled when it, or a call made while its events were dispatched, could have
 * moved the core's next deadline.
 */
export type DeadlineListener = () => void;

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
 * Moves every queued event into `drained`: the only caller of weivel_next_event. `pending` holds how many events the
 * core said wait and receives each later count, so a queue the core reported empty costs no crossing; without it the
 * drain runs until the core answers NONE. Each event is released whatever copying it does, so the next
 * weivel_next_event never meets an unreleased event, and an event that cannot be copied goes to `report` while the
 * rest are still drained.
 */
export function drainEvents(
  functions: CoreFunctions,
  core: object,
  eventBuffer: object,
  drained: CoreEvent[],
  copy: EventCopier,
  report: ListenerErrorSink,
  pending: Uint32Array | null = null,
): void {
  let waiting = pending === null ? Number.POSITIVE_INFINITY : pending[0]!;
  while (waiting > 0) {
    const status = functions.weivel_next_event(core, eventBuffer, pending) as Status;
    if (status === Status.None) {
      return;
    }
    if (status !== Status.Ok) {
      throw new Error(`weivel_next_event answered status ${status}: the layer's event struct is malformed.`);
    }
    waiting = pending === null ? waiting : pending[0]!;
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
  readonly #deadlineListeners = new Set<DeadlineListener>();
  readonly #pending = new Uint32Array(1);
  #deadlineMayHaveMoved = false;
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

  /** Adds a listener told when the core's next deadline may have moved; the answer removes it. */
  addDeadlineListener(listener: DeadlineListener): () => void {
    this.#deadlineListeners.add(listener);
    return () => this.#deadlineListeners.delete(listener);
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
      (core, pending) => this.#functions.weivel_next_deadline(core, deadline, pending),
      () => Number(deadline[0]),
    );
  }

  advance(now: number): CallResult<undefined> {
    this.#deadlineMayHaveMoved = true;
    return this.#invoke((core, pending) => this.#functions.weivel_advance(core, now, pending));
  }

  supports(manifest: Manifest): CallResult<Support> {
    return this.#invokeWithAnswer(
      "weivel_support",
      (core, answer, pending) => this.#functions.weivel_supports(core, encodeManifest(manifest), answer, pending),
      readSupport,
      (answer) => this.#functions.weivel_support_release(answer),
    );
  }

  registerManifest(manifest: Manifest): CallResult<bigint> {
    return this.#invokeForHandle((core, handle, pending) =>
      this.#functions.weivel_register_manifest(core, encodeManifest(manifest), handle, pending),
    );
  }

  planActivation(plugins: readonly bigint[], edgeSource: EdgeSource, hostProvided?: readonly string[]): CallResult<ActivationPlan> {
    const pluginList = plugins.length === 0 ? null : [...plugins];
    const provided = hostProvided === undefined ? null : encodeStrings(hostProvided);
    return this.#invokeWithAnswer(
      "weivel_activation_plan",
      (core, answer, pending) =>
        this.#functions.weivel_plan_activation(core, pluginList, plugins.length, edgeSource, provided, answer, pending),
      readActivationPlan,
      (answer) => this.#functions.weivel_activation_plan_release(answer),
    );
  }

  openPlugin(plugin: bigint, payload?: bigint): CallResult<undefined> {
    const options = payload === undefined ? null : encodePluginOptions(payload);
    return this.#invoke((core, pending) => this.#functions.weivel_open_plugin(core, plugin, options, pending));
  }

  pluginPayload(plugin: bigint): CallResult<bigint> {
    return this.#invokeForHandle((core, payload, pending) => this.#functions.weivel_plugin_payload(core, plugin, payload, pending));
  }

  releasePlugin(plugin: bigint): CallResult<undefined> {
    this.#deadlineMayHaveMoved = true;
    return this.#invoke((core, pending) => this.#functions.weivel_release_plugin(core, plugin, pending));
  }

  quarantinePlugin(plugin: bigint, reason?: QuarantineReason): CallResult<undefined> {
    this.#deadlineMayHaveMoved = true;
    const encoded = reason === undefined ? null : encodeQuarantineReason(reason);
    return this.#invoke((core, pending) => this.#functions.weivel_quarantine_plugin(core, plugin, encoded, pending));
  }

  forgetPlugin(plugin: bigint): CallResult<undefined> {
    return this.#invoke((core, pending) => this.#functions.weivel_forget_plugin(core, plugin, pending));
  }

  registerService(owner: bigint, id: string): CallResult<bigint> {
    this.#deadlineMayHaveMoved = true;
    return this.#invokeForHandle((core, handle, pending) => this.#functions.weivel_register_service(core, owner, id, handle, pending));
  }

  unregister(handle: bigint): CallResult<undefined> {
    this.#deadlineMayHaveMoved = true;
    return this.#invoke((core, pending) => this.#functions.weivel_unregister(core, handle, pending));
  }

  handleState(handle: bigint): CallResult<HandleCondition> {
    const condition: unknown[] = [0];
    return this.#invoke(
      (core, pending) => this.#functions.weivel_handle_state(core, handle, condition, pending),
      () => condition[0] as HandleCondition,
    );
  }

  getService(plugin: bigint, id: string): CallResult<bigint> {
    return this.#invokeForHandle((core, handle, pending) => this.#functions.weivel_get_service(core, plugin, id, handle, pending));
  }

  wantService(plugin: bigint, id: string, options?: WantOptions): CallResult<bigint> {
    this.#deadlineMayHaveMoved = true;
    const encoded = options === undefined ? null : encodeWantOptions(options);
    return this.#invokeForHandle((core, handle, pending) =>
      this.#functions.weivel_want_service(core, plugin, id, encoded, handle, pending),
    );
  }

  reportCapacity(want: bigint, registration: bigint, answer: CapacityAnswer, now: number): CallResult<undefined> {
    this.#deadlineMayHaveMoved = true;
    const encoded = encodeCapacity(answer);
    return this.#invoke((core, pending) => this.#functions.weivel_report_capacity(core, want, registration, encoded, now, pending));
  }

  watchService(plugin: bigint, id: string): CallResult<bigint> {
    return this.#invokeForHandle((core, handle, pending) => this.#functions.weivel_watch_service(core, plugin, id, handle, pending));
  }

  serviceIds(plugin: bigint): CallResult<string[]> {
    return this.#invokeForServiceList((core, answer, pending) => this.#functions.weivel_service_ids(core, plugin, answer, pending));
  }

  unboundServices(plugin: bigint): CallResult<string[]> {
    return this.#invokeForServiceList((core, answer, pending) =>
      this.#functions.weivel_unbound_services(core, plugin, answer, pending),
    );
  }

  provideCapability(plugin: bigint, id: string): CallResult<bigint> {
    return this.#invokeForHandle((core, handle, pending) =>
      this.#functions.weivel_provide_capability(core, plugin, id, handle, pending),
    );
  }

  verifyActivation(plugin: bigint): CallResult<undefined> {
    return this.#invoke((core, pending) => this.#functions.weivel_verify_activation(core, plugin, pending));
  }

  allCapabilities(plugin: bigint, id: string): CallResult<CapabilityImplementation[]> {
    return this.#invokeWithAnswer(
      "weivel_capability_list",
      (core, answer, pending) => this.#functions.weivel_all_capabilities(core, plugin, id, answer, pending),
      readCapabilityList,
      (answer) => this.#functions.weivel_capability_list_release(answer),
    );
  }

  watchCapability(plugin: bigint, id: string): CallResult<bigint> {
    return this.#invokeForHandle((core, handle, pending) =>
      this.#functions.weivel_watch_capability(core, plugin, id, handle, pending),
    );
  }

  ledger(): CallResult<LedgerSnapshot> {
    return this.#invokeWithAnswer(
      "weivel_ledger_snapshot",
      (core, answer, pending) => this.#functions.weivel_ledger(core, answer, pending),
      readLedgerSnapshot,
      (answer) => this.#functions.weivel_ledger_snapshot_release(answer),
    );
  }

  ledgerEntry(plugin: bigint): CallResult<LedgerRow> {
    return this.#invokeWithAnswer(
      "weivel_ledger_row",
      (core, answer, pending) => this.#functions.weivel_ledger_entry(core, plugin, answer, pending),
      readLedgerRow,
      (answer) => this.#functions.weivel_ledger_row_release(answer),
    );
  }

  #invokeForHandle(call: (core: object, handle: unknown[], pending: Uint32Array) => number): CallResult<bigint> {
    const handle: unknown[] = [0];
    return this.#invoke(
      (core, pending) => call(core, handle, pending),
      () => toBigInt(handle[0]),
    );
  }

  #invokeForServiceList(call: (core: object, answer: object, pending: Uint32Array) => number): CallResult<string[]> {
    return this.#invokeWithAnswer("weivel_service_list", call, readServiceList, (answer) =>
      this.#functions.weivel_service_list_release(answer),
    );
  }

  #invokeWithAnswer<Value>(
    answerStruct: CoreStructName,
    call: (core: object, answer: object, pending: Uint32Array) => number,
    read: (answer: object) => Value,
    release: Release,
  ): CallResult<Value> {
    const answer = allocateZeroed(answerStruct);
    try {
      return this.#invoke(
        (core, pending) => call(core, answer, pending),
        () => readThenRelease(answer, read, release),
      );
    } finally {
      koffi.free(answer);
    }
  }

  /**
   * The one function every call taking a core goes through: it makes the call, reads the call's value when the
   * status is OK, drains what the core said waits, and dispatches what it drained. The drain runs whatever the call
   * or the read throws, so a call's events always belong to it; a call that threw before the core answered says
   * nothing of the queue, which is then drained until the core answers NONE.
   */
  #invoke<Value>(call: (core: object, pending: Uint32Array) => number, readValue?: () => Value): CallResult<Value> {
    const core = this.#liveCore();
    const events: CoreEvent[] = [];
    let answered = false;
    try {
      const status = call(core, this.#pending) as Status;
      answered = true;
      const value = status === Status.Ok ? readValue?.() : undefined;
      return { status, events, value };
    } finally {
      this.#drainAndSettle(core, events, answered ? this.#pending : null);
    }
  }

  #drainAndSettle(core: object, events: CoreEvent[], pending: Uint32Array | null): void {
    try {
      drainEvents(
        this.#functions,
        core,
        this.#event,
        events,
        copyEvent,
        (error, event) => this.reportListenerError(error, event),
        pending,
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
    if (this.#deadlineMayHaveMoved) {
      this.#deadlineMayHaveMoved = false;
      this.#notify(this.#deadlineListeners);
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
    this.#notify(this.#drainListeners);
  }

  #notify(listeners: ReadonlySet<() => void>): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        this.reportListenerError(error);
      }
    }
  }
}
