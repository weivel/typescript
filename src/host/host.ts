import { wrapperHooks, type WrapperHooks } from "../core/core.js";
import {
  createCore,
  PluginStatus,
  Status,
  type ActivationPlan,
  type CallResult,
  type Core,
  type CoreEvent,
  type LedgerSnapshot,
  type Manifest,
  type QuarantineReason,
  type ReachRefusedEvent,
  type Refusal,
} from "../core/index.js";
import {
  consoleLogger,
  failureOf,
  PluginContexts,
  RefusalError,
  type Logger,
  type PluginContext,
  type RegisterOptions,
  type ServiceType,
} from "../context/index.js";
import { HandleTable } from "../handles/index.js";
import type { LibraryDeclaration } from "../standard/answers.js";
import { FunctionKind } from "../standard/constants.js";
import { CoreTimer } from "../timer/index.js";
import { activationFailureOf, type ActivationFailure } from "./activation-failure.js";
import { writeCoreLog } from "./core-log.js";
import { frozenCopyOf } from "./frozen-copy.js";
import { bindLibrary, type BoundLibrary } from "./libraries.js";
import {
  hostDestroyed,
  type ActivationOutcome,
  type ActivationStart,
  type ActivationState,
  type HostDestroyed,
  type HostedPlugin,
  type HostOptions,
  type LoadedLibrary,
  type LoadLibraryOptions,
  type Plugin,
  type RegisterAnswer,
} from "./model.js";
import { afterSettling, isThenable, settledCall } from "./settling.js";

interface PluginRecord {
  readonly hosted: HostedPlugin;
  /** Whether its activate has been called, so its deactivate is owed. */
  activated: boolean;
  /** Settles the outcome its activation answers, once. */
  settleOutcome: ((outcome: ActivationOutcome) => void) | undefined;
  /** Its release, once one began; a later release answers the same. */
  release: Promise<void> | undefined;
  /** Its context, built at its first open and kept until it is forgotten, a quarantined plugin's opened again included. */
  context: PluginContext | undefined;
}

const boundKinds: readonly number[] = [FunctionKind.Bytes, FunctionKind.Definition];

/**
 * Refuses, as the caller's mistake, a declaration the standard's reader would refuse: a kind of neither bytes nor
 * definition, a definition beside another function or with context facts, or bytes functions with no release.
 */
function refuseMisdeclared(declaration: LibraryDeclaration): void {
  for (const service of declaration.services) {
    const unbound = service.functions.find((declared) => !boundKinds.includes(declared.kind));
    if (unbound !== undefined) {
      throw new Error(`${declaration.importName}'s function ${unbound.name} is of kind ${unbound.kind}; this layer binds the bytes and definition kinds alone.`);
    }
    const definition = service.functions.find((declared) => declared.kind === FunctionKind.Definition);
    if (definition !== undefined && service.functions.length > 1) {
      throw new Error(`${declaration.importName}'s service ${service.id} declares the definition ${definition.name} beside another function.`);
    }
    if (definition !== undefined && definition.context !== 0) {
      throw new Error(`${declaration.importName}'s definition ${definition.name} reads context facts, which a definition carries in its own struct.`);
    }
    if (definition === undefined && service.functions.length > 0 && declaration.release === null) {
      throw new Error(`${declaration.importName} declares bytes functions and no release.`);
    }
    if (service.description !== undefined && (definition === undefined || service.description === "")) {
      throw new Error(`${declaration.importName}'s service ${service.id} declares a description, which only a definition's service declares, by a symbol.`);
    }
  }
}

/**
 * A host-made reason with each NUL written out.
 *
 * @implNote The reason quotes what a plugin's activate threw, which may hold a NUL a C text cannot carry whole; the
 * host writes the text, so it keeps it whole rather than letting the quarantine be refused.
 */
function reasonForC(reason: QuarantineReason): QuarantineReason {
  return { ...reason, detail: reason.detail.replaceAll("\u0000", "\\0"), fix: reason.fix.replaceAll("\u0000", "\\0") };
}

/** @throws Error when the core answers a status with no refusal for the plan. */
function refusedPlan(planned: CallResult<ActivationPlan>): ActivationStart {
  const failure = failureOf("weivel_plan_activation", planned);
  if (!(failure instanceof RefusalError)) {
    throw failure;
  }
  return { plan: undefined, outcomes: undefined, refusal: failure };
}

/** What the host's own modules reach of a host, and its exports never hand its caller. */
export interface HostInternals {
  readonly core: Core;
  readonly contexts: PluginContexts;
}

let internalsOf: (host: Host) => HostInternals;

/** The core and contexts of `host`; exported from this file only, never from the host module. */
export function hostInternals(host: Host): HostInternals {
  return internalsOf(host);
}

function succeeded(call: string, result: { status: Status; events: readonly CoreEvent[] }): void {
  if (result.status !== Status.Ok) {
    throw failureOf(call, { ...result, value: undefined });
  }
}

/**
 * Registers, activates, releases and forgets plugins on one core, and offers the host's own services and C libraries
 * to them. Every decision is the core's; the host carries its answers out. It never needs the standard: reading
 * manifests, discovering plugins on disk and reading library declarations are the standard module's, which feeds
 * `register` and `loadLibrary`.
 *
 * What goes wrong in code the host calls, a deactivate, a release or an unload, goes to the error sink and never to
 * the caller. Once destroyed, every call answers `hostDestroyed` as a value, quietly.
 */
export class Host {
  static {
    internalsOf = (host) => ({ core: host.#core, contexts: host.#contexts });
  }

  readonly #core: Core;
  readonly #hooks: WrapperHooks;
  readonly #contexts: PluginContexts;
  readonly #options: HostOptions;
  readonly #log: Logger;
  readonly #timer: CoreTimer;
  readonly #plugins = new HandleTable<PluginRecord>();
  readonly #hostServiceCounts = new Map<string, number>();
  /** Every plugin the host opened and has not released, in the order it opened them. */
  readonly #opened: PluginRecord[] = [];
  readonly #libraryUnloads = new Set<() => void>();
  /** Every C library binary still open, closed once the core is destroyed whatever still holds it. */
  readonly #openBinaries = new Set<BoundLibrary>();
  /** The import name of the live C library that declares each id. */
  readonly #libraryIds = new Map<string, string>();
  /** Every release under way, so a destroy waits for each, one begun before it included. */
  readonly #releases = new Set<Promise<void>>();
  #destroyed = false;
  #destruction: Promise<void> | undefined;

  /** @throws Error when the core's library is missing or the core cannot be created. */
  static create(options: HostOptions): Host {
    return new Host(options);
  }

  /**
   * @implNote The core is created with the host's dispatcher, because its creation is drained as any call is: an
   * event it queued would be heard by no one if the dispatcher were set afterwards. Such an event names no plugin,
   * so the contexts not existing yet loses nothing.
   */
  private constructor(options: HostOptions) {
    this.#options = options;
    this.#log = options.log ?? consoleLogger;
    const created = createCore({
      libraryPath: options.coreLibraryPath,
      options: options.core,
      onListenerError: options.onListenerError,
      dispatcher: (event) => this.#dispatch(event),
    });
    if (created.value === undefined) {
      throw new Error(`weivel_core_create answered status ${created.status}.`);
    }
    this.#core = created.value;
    this.#hooks = wrapperHooks(this.#core);
    this.#contexts = new PluginContexts(this.#core, { clock: options.clock, log: this.#log });
    this.#timer = new CoreTimer(this.#core, { clock: options.clock, scheduler: options.scheduler, onMove: options.onTimerMove });
  }

  /** Whether `destroy` has begun its work; every call from then on answers `hostDestroyed`. */
  get destroyed(): boolean {
    return this.#destroyed;
  }

  /**
   * @remarks A refusal event is not reported here: it is the answer of the call that queued it, which that call's
   * caller reads, so an activation check the host answers with a quarantine is never also a refusal of the run.
   */
  #dispatch(event: CoreEvent): void {
    if (event.kind === "log") {
      writeCoreLog(this.#log, event);
    } else if (event.kind === "reach-refused") {
      this.#log.warn(this.#reachRefusedText(event));
    }
    this.#contexts?.receive(event);
  }

  #reachRefusedText(event: ReachRefusedEvent): string {
    const name = this.#plugins.lookup(event.plugin)?.hosted.manifest.importName ?? `plugin ${event.plugin}`;
    return `${name} was refused ${event.id ?? "an id"}: ${event.refusal.detail ?? `code ${event.refusal.code}`}`;
  }

  #sink(error: unknown): void {
    this.#core.reportListenerError(error);
  }

  /**
   * Registers a plugin from its manifest and the entry its caller hands in, answering its handle or the core's refusal.
   * The host registers, keeps and answers a frozen copy of the manifest, so the caller may change its own afterwards.
   *
   * @throws Error when the core answers a status with no refusal for it, out of memory among them; EmbeddedNulError,
   * before the core is called, for a text of the manifest that holds a NUL.
   */
  register(manifest: Manifest, entry: Plugin): RegisterAnswer | HostDestroyed {
    if (this.#destroyed) {
      return hostDestroyed;
    }
    const kept = frozenCopyOf(manifest);
    const registered = this.#hooks.holdDispatch(() => {
      const answer = this.#core.registerManifest(kept);
      if (answer.status === Status.Ok && answer.value !== undefined) {
        const hosted = { plugin: answer.value, manifest: kept, entry };
        this.#plugins.add(answer.value, { hosted, activated: false, settleOutcome: undefined, release: undefined, context: undefined });
      }
      return answer;
    });
    if (registered.status === Status.Ok && registered.value !== undefined) {
      return { plugin: registered.value, refusal: undefined };
    }
    const failure = failureOf("weivel_register_manifest", registered);
    if (!(failure instanceof RefusalError)) {
      throw failure;
    }
    return { plugin: undefined, refusal: failure };
  }

  /**
   * The core's ledger as it stands now: one row per plugin registered and not forgotten, each as the core keeps it,
   * a quarantined plugin's reason included.
   *
   * @throws Error when the core answers a status other than OK, out of memory among them.
   */
  ledger(): LedgerSnapshot | HostDestroyed {
    if (this.#destroyed) {
      return hostDestroyed;
    }
    const ledger = this.#core.ledger();
    if (ledger.value === undefined) {
      throw failureOf("weivel_ledger", ledger);
    }
    return ledger.value;
  }

  /** The plugin the host registered under `plugin`, or undefined once it is forgotten or for a handle never known. */
  plugin(plugin: bigint): HostedPlugin | undefined {
    return this.#plugins.lookup(plugin)?.hosted;
  }

  /**
   * Registers a service the host itself supplies under WEIVEL_HOST; the answer unregisters it.
   *
   * @throws Error for an id a live C library declares, since a registration under the host replaces one; RefusalError
   * when the core refuses it; EmbeddedNulError for an id that holds a NUL.
   */
  registerHostService<Service>(type: ServiceType<Service>, service: Service, options: RegisterOptions = {}): (() => void) | HostDestroyed {
    if (this.#destroyed) {
      return hostDestroyed;
    }
    this.#refuseLibraryId(type.id);
    if (this.#contexts.offersToPlugins(type.id)) {
      throw new Error(`${type.id} is offered to plugins one by one, so the host may not register it for every plugin as well.`);
    }
    return this.#registerHostService(type, service, options);
  }

  /**
   * Offers a service the host itself supplies to one registered plugin alone; the answer withdraws it. The core
   * decides reach as for any host service: every plugin offered an id shares one registration under WEIVEL_HOST, and
   * each plugin that reaches it gets the object offered to it, a plugin offered nothing under that id nothing.
   *
   * @throws Error for a plugin the host never registered or has forgotten, an id a live C library declares or the
   * host registered for every plugin, or one already offered to that plugin; RefusalError when the core refuses the
   * registration; EmbeddedNulError for an id that holds a NUL.
   */
  registerPluginService<Service>(plugin: bigint, type: ServiceType<Service>, service: Service): (() => void) | HostDestroyed {
    if (this.#destroyed) {
      return hostDestroyed;
    }
    this.#record(plugin);
    this.#refuseLibraryId(type.id);
    const withdraw = this.#contexts.registerPluginService(plugin, type, service);
    return () => {
      if (!this.#destroyed) {
        withdraw();
      }
    };
  }

  #refuseLibraryId(id: string): void {
    const library = this.#libraryIds.get(id);
    if (library !== undefined) {
      throw new Error(`The C library ${library} declares ${id}, so the host may not register it under the host as well.`);
    }
  }

  #registerHostService<Service>(type: ServiceType<Service>, service: Service, options: RegisterOptions, whenReleased?: () => void): () => void {
    const unregister = this.#contexts.registerHostService(type, service, options, whenReleased);
    this.#countHostService(type.id, 1);
    let registered = true;
    return () => {
      if (registered && !this.#destroyed) {
        registered = false;
        unregister();
        this.#countHostService(type.id, -1);
      }
    };
  }

  #countHostService(id: string, change: number): void {
    const count = (this.#hostServiceCounts.get(id) ?? 0) + change;
    if (count === 0) {
      this.#hostServiceCounts.delete(id);
    } else {
      this.#hostServiceCounts.set(id, count);
    }
  }

  /**
   * Binds each bytes function of a C library's declaration, read by the standard or built by the caller, calls each
   * definition's symbol once, and registers each declared service under WEIVEL_HOST: a service of bytes functions as
   * an object with one function per declared function, a definition that declares a description as the object its
   * description binds (`BoundDefinition`), once the host's `descriptionCheck` has passed it, and any other definition
   * as a LibraryDefinition carrying the very address its symbol answered, each definition registered awaiting
   * releases.
   *
   * An id `options.withheld` names is bound as any other and registered for no plugin, so only the caller reaches it,
   * through the answer.
   *
   * Unloading unregisters every service at once and refuses every later bytes call; the binary is closed once every
   * definition service has had every holding of it released, or once the host is destroyed.
   *
   * @throws Error when a declaration the caller built names a kind other than bytes or definition, sets a definition
   * beside another function or gives one context facts, or names bytes functions and no release; an id is declared
   * twice or is already registered, by another live library, a plugin or the host itself; the library file is
   * missing or lacks a symbol its declaration names; a definition answers NULL or a struct smaller than
   * `2 * sizeof(void *)`; or a description is declared beside no definition, to a host given no `descriptionCheck`,
   * answers NULL, is refused by the check or disagrees with this platform's layout: each the caller's mistake,
   * reported to no sink, the binary closed again. OutOfMemoryError when the description check answers OUT_OF_MEMORY,
   * the binary closed again. RefusalError when the core refuses one of its registrations, the load then undone as an
   * unload.
   */
  loadLibrary(declaration: LibraryDeclaration, libraryPath: string, options: LoadLibraryOptions = {}): LoadedLibrary | HostDestroyed {
    if (this.#destroyed) {
      return hostDestroyed;
    }
    refuseMisdeclared(declaration);
    const withheld = new Set(options.withheld ?? []);
    this.#refuseHeldIds(declaration, withheld);
    const bound = bindLibrary(libraryPath, declaration, () => this.#openBinaries.delete(bound), this.#options.descriptionCheck);
    this.#openBinaries.add(bound);
    const unregisters: (() => void)[] = [];
    const ids = [...bound.services.keys(), ...bound.definitions.keys()];
    const unload = (): void => {
      if (!this.#libraryUnloads.delete(unload)) {
        return;
      }
      ids.forEach((id) => this.#libraryIds.delete(id));
      unregisters.splice(0).forEach((unregister) => unregister());
      bound.unload();
    };
    this.#libraryUnloads.add(unload);
    ids.forEach((id) => this.#libraryIds.set(id, declaration.importName));
    try {
      this.#registerLibraryServices(bound, unregisters, withheld);
    } catch (error) {
      unload();
      throw error;
    }
    return { declaration, services: bound.services, definitions: bound.definitions, described: bound.described, unload };
  }

  #registerLibraryServices(bound: BoundLibrary, unregisters: (() => void)[], withheld: ReadonlySet<string>): void {
    for (const [id, service] of bound.services) {
      if (!withheld.has(id)) {
        unregisters.push(this.#registerHostService({ id }, service, {}));
      }
    }
    for (const [id, definition] of bound.definitions) {
      if (withheld.has(id)) {
        continue;
      }
      bound.awaitRelease(id);
      try {
        unregisters.push(this.#registerHostService({ id }, bound.described.get(id) ?? definition, {}, () => bound.released(id)));
      } catch (error) {
        bound.released(id);
        throw error;
      }
    }
  }

  /**
   * @implNote A registration under WEIVEL_HOST replaces one, so a library may take no id something already holds; an
   * id it withholds registers nothing, so it replaces nothing.
   */
  #refuseHeldIds(declaration: LibraryDeclaration, withheld: ReadonlySet<string>): void {
    const declared = new Set<string>();
    for (const { id } of declaration.services) {
      if (declared.has(id)) {
        throw new Error(`The C library ${declaration.importName} declares ${id} twice.`);
      }
      declared.add(id);
      if (!withheld.has(id) && this.#contexts.registers(id)) {
        throw new Error(`${id} is already registered, so the C library ${declaration.importName} may not register it under the host.`);
      }
    }
  }

  /**
   * Plans the activation of `plugins` with the core, then starts each plugin of the plan's order in that order: opens
   * it, builds its context and calls its entry's activate, never waiting for one to finish before starting the next.
   * It answers the plan at once; `outcomes` settles once every activate has, each verified or quarantined as it settles.
   * A plan the core refuses is answered as that refusal, with no plan and no outcomes.
   *
   * The plan is started as one step of a dispatch: as the dispatcher when none runs, so what the activates' own calls
   * queue is dispatched once every activate has been called, and as a call made inside the dispatch that runs. An
   * activate that settles before it returns, by returning something other than a promise or by throwing, is verified,
   * or quarantined, before the next plugin starts; a promise is read when it settles, since its state cannot be read
   * sooner.
   *
   * @implNote A plugin whose activate awaits a want of a service a later plugin registers would otherwise hold back
   * every plugin behind it for good, and the core sets no default timeout on a want; and a host whose activation
   * waited for every activate could never be destroyed while one waits on a want nothing provides.
   * @throws Error when the core answers a status with no refusal for the plan, out of memory among them.
   */
  activate(plugins: readonly bigint[]): ActivationStart | HostDestroyed {
    if (this.#destroyed) {
      return hostDestroyed;
    }
    const planned = this.#core.planActivation(plugins, this.#options.edgeSource, [...this.#hostServiceCounts.keys()]);
    const plan = planned.value;
    if (plan === undefined) {
      return refusedPlan(planned);
    }
    const outcomes = this.#hooks.holdDispatch(() => this.#startEveryPlugin(plan));
    return { plan, outcomes: Promise.all(outcomes), refusal: undefined };
  }

  #startEveryPlugin(plan: ActivationPlan): Promise<ActivationOutcome>[] {
    return plan.order.map((plugin) => this.#startActivation(this.#record(plugin)));
  }

  /**
   * @implNote An open that fails for a reason other than the core's refusal is a defect of this layer, so it goes to
   * the error sink; answering it as that plugin's `failed` outcome, rather than throwing, keeps the plan and the
   * plugins already started in the caller's hands.
   */
  #startActivation(record: PluginRecord): Promise<ActivationOutcome> {
    if (this.#destroyed) {
      return Promise.resolve(this.#outcome(record, "released", undefined));
    }
    let context: PluginContext;
    try {
      context = this.#open(record);
    } catch (error) {
      if (error instanceof RefusalError) {
        return Promise.resolve(this.#outcome(record, "refused", error));
      }
      this.#sink(error);
      const failed = this.#outcome(record, "failed", undefined);
      return this.#releaseIfOpened(record).then(() => failed);
    }
    if (this.#destroyed) {
      return this.#releaseWithoutActivating(record);
    }
    return new Promise((resolve) => {
      record.settleOutcome = resolve;
      record.activated = true;
      this.#callTheActivate(record, context);
    });
  }

  /** Calls the entry's activate, and verifies or quarantines it at once when it settled before returning. */
  #callTheActivate(record: PluginRecord, context: PluginContext): void {
    let activating: unknown;
    try {
      activating = record.hosted.entry.activate(context);
    } catch (error) {
      this.#activationSettled(record, activationFailureOf(error));
      return;
    }
    if (!isThenable(activating)) {
      this.#activationSettled(record, undefined);
      return;
    }
    Promise.resolve(activating).then(
      () => this.#activationSettled(record, undefined),
      (error: unknown) => this.#activationSettled(record, activationFailureOf(error)),
    );
  }

  /**
   * Releases a plugin opened as the destroy began, its activate never called, answering it `released` at once.
   *
   * @implNote The destroy's own release of it may already have begun inside the open's dispatch, before there was an
   * outcome to settle, so the outcome is answered here rather than by the release.
   */
  #releaseWithoutActivating(record: PluginRecord): Promise<ActivationOutcome> {
    void this.#release(record).catch((error: unknown) => this.#sink(error));
    return Promise.resolve(this.#outcome(record, "released", undefined));
  }

  /** Verifies or quarantines a plugin whose activate settled, unless it was released or the host destroyed since. */
  #activationSettled(record: PluginRecord, failure: ActivationFailure | undefined): void {
    if (record.release !== undefined || this.#destroyed) {
      return;
    }
    const outcome = failure === undefined ? this.#verify(record) : this.#quarantine(record, failure.reason);
    this.#settleOutcome(record, outcome);
  }

  /**
   * Releases and forgets a plugin whose open failed after the core opened it, by the release steps that still apply.
   *
   * @implNote Its activate was never called, so no deactivate is owed; left alone it would stay open in the core
   * until destroy with no outcome of its own.
   */
  #releaseIfOpened(record: PluginRecord): Promise<void> {
    if (!this.#opened.includes(record)) {
      return Promise.resolve();
    }
    return this.#release(record).catch((error: unknown) => this.#sink(error));
  }

  #settleOutcome(record: PluginRecord, outcome: ActivationOutcome): void {
    const settle = record.settleOutcome;
    record.settleOutcome = undefined;
    settle?.(outcome);
  }

  /**
   * Opens a registered plugin with its table key as the payload and builds its context.
   *
   * @throws RefusalError when the core refuses to open it.
   */
  open(plugin: bigint): PluginContext | HostDestroyed {
    if (this.#destroyed) {
      return hostDestroyed;
    }
    return this.#open(this.#record(plugin));
  }

  /**
   * Builds the plugin's context unless it has one, then opens it, the host's record of it as opened made before any
   * event of the open is dispatched.
   *
   * @implNote A plugin the host holds open, its activate in flight or not, keeps the context it has: the core refuses
   * to open it again, and a context built for that open would take the place of the one the plugin still uses. A
   * quarantined plugin opened again keeps its context the same way. An open that throws may have reached the core or
   * not; the ledger says whether the core holds the plugin open, and only then is it kept as opened.
   */
  #open(record: PluginRecord): PluginContext {
    const built = record.context === undefined;
    const context = record.context ?? this.#contexts.create(record.hosted.plugin, record.hosted.manifest, this.#pluginLog(record.hosted.manifest));
    record.context = context;
    try {
      succeeded("weivel_open_plugin", this.#hooks.holdDispatch(() => this.#openInCore(record)));
    } catch (error) {
      this.#keepIfHeldOpen(record, built);
      throw error;
    }
    return context;
  }

  #openInCore(record: PluginRecord): CallResult<undefined> {
    const opened = this.#core.openPlugin(record.hosted.plugin, record.hosted.plugin);
    if (opened.status === Status.Ok) {
      this.#dropFromOpened(record);
      this.#opened.push(record);
    }
    return opened;
  }

  #keepIfHeldOpen(record: PluginRecord, built: boolean): void {
    const plugin = record.hosted.plugin;
    if (this.#core.ledgerEntry(plugin).value?.status !== PluginStatus.Active) {
      if (built) {
        this.#contexts.forget(plugin);
        record.context = undefined;
      }
    } else if (!this.#opened.includes(record)) {
      this.#opened.push(record);
    }
  }

  #pluginLog(manifest: Manifest): Logger {
    return this.#options.pluginLog?.(manifest) ?? this.#log;
  }

  /**
   * Checks a plugin's activation with the core, and quarantines it in the same step when the core refuses. A plugin
   * the host holds nothing of open, registered only or never registered, is answered as the core answers it, `active`
   * or `refused` with the core's refusal, and quarantined by nothing.
   */
  verify(plugin: bigint): ActivationOutcome | HostDestroyed {
    if (this.#destroyed) {
      return hostDestroyed;
    }
    const record = this.#plugins.lookup(plugin);
    return record !== undefined && this.#opened.includes(record) ? this.#verify(record) : this.#verifyUnopened(plugin, record);
  }

  /** @implNote The quarantine is made before any event of the verification is dispatched. */
  #verify(record: PluginRecord): ActivationOutcome {
    return this.#hooks.holdDispatch(() => {
      const verified = this.#core.verifyActivation(record.hosted.plugin);
      if (verified.status === Status.Ok) {
        return this.#outcome(record, "active", undefined);
      }
      const failure = failureOf("weivel_verify_activation", verified);
      return this.#quarantine(record, undefined, failure instanceof RefusalError ? failure : undefined);
    });
  }

  #verifyUnopened(plugin: bigint, record: PluginRecord | undefined): ActivationOutcome {
    const verified = this.#core.verifyActivation(plugin);
    const importName = record?.hosted.manifest.importName;
    if (verified.status === Status.Ok) {
      return { plugin, importName, state: "active", refusal: undefined };
    }
    const failure = failureOf("weivel_verify_activation", verified);
    return { plugin, importName, state: "refused", refusal: failure instanceof RefusalError ? failure : undefined };
  }

  /**
   * Quarantines a plugin, its entries ending once the events its quarantine queued have reached it. With no reason,
   * its ledger row shows the refusal its activation check answered. The outcome carries `decidedBy`, the core's
   * refusal that quarantined it, and nothing for a quarantine for a reason of the host's, which its ledger row keeps.
   */
  #quarantine(record: PluginRecord, reason: QuarantineReason | undefined, decidedBy?: Refusal): ActivationOutcome {
    const plugin = record.hosted.plugin;
    const quarantined = this.#core.quarantinePlugin(plugin, reason === undefined ? undefined : reasonForC(reason));
    if (quarantined.status !== Status.Ok) {
      this.#sink(failureOf("weivel_quarantine_plugin", quarantined));
    }
    this.#contexts.whenEventsHandled(() => this.#contexts.stopped(plugin));
    return this.#outcome(record, "quarantined", decidedBy);
  }

  #outcome(record: PluginRecord, state: ActivationState, refusal: Refusal | undefined): ActivationOutcome {
    return { plugin: record.hosted.plugin, importName: record.hosted.manifest.importName, state, refusal };
  }

  /**
   * Releases a plugin: calls its deactivate while it is still whole, releases it in the core, lets every event that
   * release queued reach it, then ends its entries, forgets it and drops it from every table. A plugin whose activate
   * is still running is released the same way, and its activate settling later does nothing.
   *
   * It answers true once the release has run, and false at once, doing nothing, for a plugin the host has not opened:
   * one registered only, or one already forgotten.
   *
   * @remarks Inside a dispatch the release's events cannot be dispatched before the call returns, so ending the
   * entries and forgetting wait as a step behind them; the promise settles once that step has run.
   */
  release(plugin: bigint): Promise<boolean | HostDestroyed> {
    if (this.#destroyed) {
      return Promise.resolve(hostDestroyed);
    }
    const record = this.#plugins.lookup(plugin);
    if (record === undefined || (record.release === undefined && !this.#opened.includes(record))) {
      return Promise.resolve(false);
    }
    return this.#release(record).then(() => true);
  }

  #release(record: PluginRecord): Promise<void> {
    if (record.release === undefined) {
      const release = this.#beginRelease(record);
      record.release = release;
      this.#releases.add(release);
      void release.then(
        () => this.#releases.delete(release),
        () => this.#releases.delete(release),
      );
    }
    return record.release;
  }

  #beginRelease(record: PluginRecord): Promise<void> {
    this.#dropFromOpened(record);
    this.#settleOutcome(record, this.#outcome(record, "released", undefined));
    return afterSettling(this.#deactivate(record), () => this.#releaseInCore(record));
  }

  #dropFromOpened(record: PluginRecord): void {
    const index = this.#opened.indexOf(record);
    if (index !== -1) {
      this.#opened.splice(index, 1);
    }
  }

  /** Calls the entry's deactivate when its activate was called; what it throws or rejects with goes to the sink. */
  #deactivate(record: PluginRecord): unknown {
    const entry = record.hosted.entry;
    if (!record.activated || typeof entry.deactivate !== "function") {
      return undefined;
    }
    record.activated = false;
    const deactivating = settledCall(() => entry.deactivate!());
    return isThenable(deactivating) ? Promise.resolve(deactivating).catch((error: unknown) => this.#sink(error)) : deactivating;
  }

  #releaseInCore(record: PluginRecord): Promise<void> {
    const plugin = record.hosted.plugin;
    const released = this.#core.releasePlugin(plugin);
    if (released.status !== Status.Ok) {
      this.#sink(failureOf("weivel_release_plugin", released));
    }
    return new Promise((resolve) =>
      this.#contexts.whenEventsHandled(() => {
        try {
          this.#forget(plugin);
        } finally {
          resolve();
        }
      }),
    );
  }

  /** Ends a released plugin's entries, calling nothing in the core for them, then forgets it. */
  #forget(plugin: bigint): void {
    this.#contexts.stopped(plugin);
    const forgotten = this.#core.forgetPlugin(plugin);
    if (forgotten.status !== Status.Ok) {
      this.#sink(failureOf("weivel_forget_plugin", forgotten));
    }
    this.#contexts.forget(plugin);
    this.#plugins.drop(plugin);
  }

  #record(plugin: bigint): PluginRecord {
    const record = this.#plugins.lookup(plugin);
    if (record === undefined) {
      throw new Error(`The host registered no plugin ${plugin}.`);
    }
    return record;
  }

  /**
   * Releases every plugin the host opened and has not released, the last opened first and one whose activate is in
   * flight included, lets every event and step those releases left run, unloads every C library, stops the timer and
   * destroys the core. Inside a dispatch it waits as a step behind what is already queued. A release already under
   * way is waited for, however long its deactivate takes. Every other call is quiet from the moment this is called,
   * and a later call answers the first one's promise, which never rejects: what fails goes to the error sink.
   */
  destroy(): Promise<void> {
    if (this.#destruction === undefined) {
      this.#destroyed = true;
      this.#destruction = new Promise((resolve) => this.#contexts.whenEventsHandled(() => resolve(this.#shutDown())));
    }
    return this.#destruction;
  }

  async #shutDown(): Promise<void> {
    try {
      for (const record of [...this.#opened].reverse()) {
        await this.#release(record).catch((error: unknown) => this.#sink(error));
      }
      await this.#releasesSettled();
      await new Promise<void>((resolve) => this.#contexts.whenEventsHandled(resolve));
    } finally {
      try {
        this.#unloadEveryLibrary();
        this.#timer.stop();
      } finally {
        this.#core.destroy();
        [...this.#openBinaries].forEach((binary) => binary.close());
      }
    }
  }

  /** Waits until no release is under way, those begun while waiting included. */
  async #releasesSettled(): Promise<void> {
    while (this.#releases.size > 0) {
      await Promise.allSettled([...this.#releases]);
    }
  }

  #unloadEveryLibrary(): void {
    for (const unload of [...this.#libraryUnloads]) {
      try {
        unload();
      } catch (error) {
        this.#libraryUnloads.delete(unload);
        this.#sink(error);
      }
    }
  }
}
