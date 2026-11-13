import { createCore, Status, type Core, type CoreEvent, type Manifest, type ReachRefusedEvent, type QuarantineReason, type Refusal } from "../core/index.js";
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
import { loadStandard, type Standard } from "../standard/index.js";
import { CoreTimer } from "../timer/index.js";
import { writeCoreLog } from "./core-log.js";
import { discoverPlugins } from "./discovery.js";
import { bindLibrary } from "./libraries.js";
import type {
  ActivationOutcome,
  ActivationReport,
  ActivationState,
  DiscoveryReport,
  HostedPlugin,
  HostOptions,
  LibraryAnswer,
  Plugin,
} from "./model.js";
import { activateThrew, ActivationFailure, importPlugin, messageOf } from "./plugin-module.js";

interface PluginRecord {
  readonly hosted: HostedPlugin;
  /** The entry's default export once its activate has been called, until its deactivate is. */
  definition: Plugin | undefined;
}

function succeeded(call: string, result: { status: Status; events: readonly CoreEvent[] }): void {
  if (result.status !== Status.Ok) {
    throw failureOf(call, { ...result, value: undefined });
  }
}

/**
 * Discovers, loads, activates, releases and forgets plugins on one core, and offers the host's own services and C
 * libraries to them. Every decision is the core's or the standard's; the host carries their answers out.
 */
export class Host {
  readonly core: Core;
  readonly standard: Standard;
  readonly contexts: PluginContexts;
  readonly #options: HostOptions;
  readonly #log: Logger;
  readonly #timer: CoreTimer;
  readonly #plugins = new HandleTable<PluginRecord>();
  readonly #hostServiceCounts = new Map<string, number>();
  /** Every plugin the core verified active and the host has not released, the latest activated last. */
  readonly #activeOrder: bigint[] = [];
  readonly #libraryUnloads = new Set<() => void>();
  #destroyed = false;
  #destruction: Promise<void> | undefined;

  /** @throws Error when either library is missing or the core cannot be created. */
  static create(options: HostOptions): Host {
    const standard = loadStandard(options.standardLibraryPath);
    const created = createCore({ libraryPath: options.coreLibraryPath, options: options.core, onListenerError: options.onListenerError });
    if (created.value === undefined) {
      throw new Error(`weivel_core_create answered status ${created.status}.`);
    }
    return new Host(created.value, standard, options);
  }

  private constructor(core: Core, standard: Standard, options: HostOptions) {
    this.core = core;
    this.standard = standard;
    this.#options = options;
    this.#log = options.log ?? consoleLogger;
    this.contexts = new PluginContexts(core, { clock: options.clock, log: this.#log });
    core.setDispatcher((event) => this.#dispatch(event));
    this.#timer = new CoreTimer(core, { clock: options.clock, scheduler: options.scheduler });
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
    this.contexts.receive(event);
  }

  #reachRefusedText(event: ReachRefusedEvent): string {
    const name = this.#plugins.lookup(event.plugin)?.hosted.manifest.importName ?? `plugin ${event.plugin}`;
    return `${name} was refused ${event.id ?? "an id"}: ${event.refusal.detail ?? `code ${event.refusal.code}`}`;
  }

  /** Discovers the plugins in `directory`, reports the ones the core does not support, and registers the rest. */
  discover(directory: string): DiscoveryReport {
    const wellKnownServices = this.#options.core?.wellKnownServices;
    const report = discoverPlugins(this.core, this.standard, directory, wellKnownServices === undefined ? {} : { wellKnownServices });
    for (const hosted of report.registered) {
      this.#plugins.add(hosted.plugin, { hosted, definition: undefined });
    }
    return report;
  }

  /** The plugin the host registered under `plugin`, or undefined once it is forgotten or for a handle never known. */
  plugin(plugin: bigint): HostedPlugin | undefined {
    return this.#plugins.lookup(plugin)?.hosted;
  }

  /** Registers a service the host itself supplies under WEIVEL_HOST; the answer unregisters it. */
  registerHostService<Service>(type: ServiceType<Service>, service: Service, options: RegisterOptions = {}): () => void {
    const unregister = this.contexts.registerHostService(type, service, options);
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
   * Reads a C library's declaration with the standard, binds each function, and registers each declared service
   * under WEIVEL_HOST.
   *
   * @throws Error when the library file is missing or lacks a symbol its declaration names.
   */
  loadLibrary(declaration: string, libraryPath: string): LibraryAnswer {
    const read = this.standard.readLibrary(declaration);
    if (read.value === undefined) {
      if (read.refusal === undefined) {
        throw new Error(`weivel_standard_read_library answered status ${read.status}.`);
      }
      return { library: undefined, refusal: read.refusal };
    }
    const bound = bindLibrary(libraryPath, read.value);
    const unregisters = [...bound.services].map(([id, service]) => this.registerHostService({ id }, service));
    const unload = (): void => {
      this.#libraryUnloads.delete(unload);
      unregisters.splice(0).forEach((unregister) => unregister());
      bound.unload();
    };
    this.#libraryUnloads.add(unload);
    return { library: { declaration: read.value, services: bound.services, unload }, refusal: undefined };
  }

  /**
   * Plans the activation of `plugins` with the core, then starts each plugin of the plan's order in turn: opens it,
   * imports its entry and calls its `activate`, without waiting for the previous plugin's `activate` to settle. Each
   * plugin's activation is checked with the core when its own `activate` settles, and the answer comes once every one
   * has.
   *
   * @implNote A plugin whose `activate` awaits a want of a service a later plugin registers would otherwise hold back
   * every plugin behind it for good, and the core sets no default timeout on a want. So a provider's `activate` may
   * still be running when its consumer's starts: a consumer that needs the service wants it.
   */
  async activate(plugins: readonly bigint[]): Promise<ActivationReport> {
    const planned = this.core.planActivation(plugins, this.#options.edgeSource, [...this.#hostServiceCounts.keys()]);
    if (planned.value === undefined) {
      throw failureOf("weivel_plan_activation", planned);
    }
    const settling: Promise<ActivationOutcome>[] = [];
    for (const plugin of planned.value.order) {
      settling.push((await this.#startActivation(plugin)).settled);
    }
    return { plan: planned.value, outcomes: await Promise.all(settling) };
  }

  /** Answers once the plugin's `activate` has been called; `settled` is its outcome once that `activate` settles. */
  async #startActivation(plugin: bigint): Promise<{ readonly settled: Promise<ActivationOutcome> }> {
    const record = this.#record(plugin);
    let context: PluginContext;
    try {
      context = this.open(plugin);
    } catch (error) {
      if (error instanceof RefusalError) {
        return { settled: Promise.resolve(this.#outcome(record, "refused", error)) };
      }
      throw error;
    }
    const imported = await this.#import(record);
    const failure = imported instanceof ActivationFailure ? Promise.resolve(imported) : this.#callActivate(record, imported, context);
    return { settled: failure.then((settledFailure) => this.#checkActivation(record, settledFailure)) };
  }

  async #import(record: PluginRecord): Promise<Plugin | ActivationFailure> {
    try {
      return await importPlugin(record.hosted.entryPath, record.hosted.entryPresent);
    } catch (error) {
      return error instanceof ActivationFailure ? error : activateThrew(error);
    }
  }

  async #callActivate(record: PluginRecord, definition: Plugin, context: PluginContext): Promise<ActivationFailure | undefined> {
    record.definition = definition;
    try {
      await definition.activate(context);
      return undefined;
    } catch (error) {
      return activateThrew(error);
    }
  }

  #checkActivation(record: PluginRecord, failure: ActivationFailure | undefined): ActivationOutcome {
    return failure === undefined ? this.verify(record.hosted.plugin) : this.#quarantine(record, failure.reason);
  }

  /**
   * Opens a registered plugin with its table key as the payload and builds its context.
   *
   * @throws RefusalError when the core refuses to open it.
   */
  open(plugin: bigint): PluginContext {
    const record = this.#record(plugin);
    succeeded("weivel_open_plugin", this.core.openPlugin(plugin, plugin));
    return this.contexts.create(plugin, record.hosted.manifest, this.#pluginLog(record.hosted.manifest));
  }

  #pluginLog(manifest: Manifest): Logger {
    return this.#options.pluginLog?.(manifest) ?? this.#log;
  }

  /** Checks a plugin's activation with the core, and quarantines it in the same step when the core refuses. */
  verify(plugin: bigint): ActivationOutcome {
    const record = this.#record(plugin);
    const verified = this.core.verifyActivation(plugin);
    if (verified.status !== Status.Ok) {
      return this.#quarantine(record, undefined);
    }
    this.#activeOrder.push(plugin);
    return this.#outcome(record, "active", undefined);
  }

  /** With no reason, the plugin's ledger row shows the refusal its activation check answered. */
  #quarantine(record: PluginRecord, reason: QuarantineReason | undefined): ActivationOutcome {
    const plugin = record.hosted.plugin;
    succeeded("weivel_quarantine_plugin", this.core.quarantinePlugin(plugin, reason));
    this.contexts.stopped(plugin);
    return this.#outcome(record, "quarantined", this.core.ledgerEntry(plugin).value?.refusal);
  }

  #outcome(record: PluginRecord, state: ActivationState, refusal: Refusal | undefined): ActivationOutcome {
    return { plugin: record.hosted.plugin, importName: record.hosted.manifest.importName, state, refusal };
  }

  /**
   * Deactivates a plugin, releases it in the core, then forgets it, dropping it from every table once the events of
   * its forgetting are handled.
   *
   * @remarks Every core call here follows an await, so none runs inside the core's dispatch, where events queued
   * before it would still wait and a pending want would be dropped unsettled.
   */
  async release(plugin: bigint): Promise<void> {
    const record = this.#record(plugin);
    await this.#deactivate(record);
    this.#dropFromActiveOrder(plugin);
    succeeded("weivel_release_plugin", this.core.releasePlugin(plugin));
    this.contexts.stopped(plugin);
    succeeded("weivel_forget_plugin", this.core.forgetPlugin(plugin));
    this.contexts.forget(plugin);
    this.#plugins.drop(plugin);
  }

  #dropFromActiveOrder(plugin: bigint): void {
    const index = this.#activeOrder.indexOf(plugin);
    if (index !== -1) {
      this.#activeOrder.splice(index, 1);
    }
  }

  async #deactivate(record: PluginRecord): Promise<void> {
    const definition = record.definition;
    record.definition = undefined;
    if (typeof definition?.deactivate !== "function") {
      return;
    }
    try {
      await definition.deactivate();
    } catch (error) {
      this.#pluginLog(record.hosted.manifest).error(
        `${record.hosted.manifest.importName}'s deactivate threw: ${messageOf(error)}`,
        error,
      );
    }
  }

  #record(plugin: bigint): PluginRecord {
    const record = this.#plugins.lookup(plugin);
    if (record === undefined) {
      throw new Error(`The host registered no plugin ${plugin}.`);
    }
    return record;
  }

  /**
   * Releases every active plugin, the latest activated first, unloads every C library the host loaded, stops the
   * timer and destroys the core. A later call answers the first call's promise.
   *
   * The promise rejects with an AggregateError of every release that failed, once the rest of the shutdown has run.
   */
  destroy(): Promise<void> {
    this.#destruction ??= this.#shutDown();
    return this.#destruction;
  }

  async #shutDown(): Promise<void> {
    const failures = await this.#releaseEveryActivePlugin();
    [...this.#libraryUnloads].forEach((unload) => unload());
    this.#timer.stop();
    this.#destroyed = true;
    this.core.destroy();
    if (failures.length > 0) {
      throw new AggregateError(failures, "Releasing a plugin failed while the host was destroyed.");
    }
  }

  async #releaseEveryActivePlugin(): Promise<unknown[]> {
    const failures: unknown[] = [];
    for (const plugin of [...this.#activeOrder].reverse()) {
      try {
        await this.release(plugin);
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  }
}
