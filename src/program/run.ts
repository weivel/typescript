import { consoleLogger, type Logger } from "../context/index.js";
import { EdgeSource } from "../core/index.js";
import { messageOf } from "../host/activation-failure.js";
import { DescribedCallError, Host, type LoadedLibrary } from "../host/index.js";
import { HostMode, loadStandard, type Standard } from "../standard/index.js";
import { loadDeclaredLibrary, loadHostLibrary } from "./libraries.js";
import { failedRunExit, isSet, type ActionEnding, type HostOutcome, type HostPlan, type RunHostOptions, type RunningHost } from "./model.js";
import { PluginRun } from "./plugins.js";
import { HostProvider } from "./provider.js";
import { StopRequest } from "./stop-request.js";

/** Logs why a run ends early: a refusal the provider answered as what it is, anything else as an error. */
function logEnding(log: Logger, during: string, error: unknown): void {
  if (error instanceof DescribedCallError) {
    log.warn(`The run ends: ${error.message}`);
  } else {
    log.error(`The run ends: ${during} failed: ${messageOf(error)}`, error);
  }
}

/** Whether the plan sets only one of `action_service` and `action_method`, or sets either to an empty text. */
function namesItsMethodMalformedly(plan: HostPlan): boolean {
  const { action_service: service, action_method: method } = plan;
  return service === "" || method === "" || isSet(service) !== isSet(method);
}

/** Destroys the run's host, logging what goes wrong, so the run still answers its exit code. */
async function destroyQuietly(host: Host | undefined, log: Logger): Promise<void> {
  try {
    await host?.destroy();
  } catch (error) {
    log.error(`Destroying the host failed: ${messageOf(error)}`, error);
  }
}

/** What one run started with an OK `start` holds, and how it carries the plan out. */
class Run {
  readonly #host: Host;
  readonly #standard: Standard;
  readonly #provider: HostProvider;
  readonly #plan: HostPlan;
  readonly #stop: StopRequest;
  readonly #log: Logger;
  readonly #plugins: PluginRun;
  readonly #libraries: LoadedLibrary[];
  readonly #starting: Starting;

  constructor(host: Host, standard: Standard, hostLibrary: LoadedLibrary, provider: HostProvider, plan: HostPlan, stop: StopRequest, options: RunHostOptions, starting: Starting) {
    this.#host = host;
    this.#standard = standard;
    this.#provider = provider;
    this.#plan = plan;
    this.#stop = stop;
    this.#log = options.log ?? consoleLogger;
    this.#plugins = new PluginRun(host, standard, options.entryExport ?? "default", this.#log);
    this.#libraries = [hostLibrary];
    this.#starting = starting;
  }

  /** The object the plugin `importName` itself registered under `id` and still has registered, or undefined. */
  serviceOf(importName: string, id: string): unknown {
    return this.#plugins.serviceOf(importName, id);
  }

  /** Carries the plan out, releases every plugin, then calls `stop` last and answers its code. */
  async carryOut(): Promise<number> {
    try {
      await this.#carryOutThePlan();
    } catch (error) {
      logEnding(this.#log, "carrying out the plan", error);
    }
    try {
      await this.#plugins.releaseEvery();
    } catch (error) {
      this.#log.error(`Releasing the plugins failed: ${messageOf(error)}`, error);
    }
    return this.#stopTheRun();
  }

  /**
   * @implNote Activation is one phase, as `host.h` says: a stop requested while it runs takes effect once `started`
   * has been told every plugin's outcome, so it is read only after that call.
   */
  async #carryOutThePlan(): Promise<void> {
    const mode = this.#plan.mode;
    if (mode !== HostMode.Serve && mode !== HostMode.Action) {
      throw new Error(`start answered the mode ${mode}, which this program does not run`);
    }
    if (mode === HostMode.Action && namesItsMethodMalformedly(this.#plan)) {
      throw new Error("start answered an action service without its method, a method without its service, or either empty");
    }
    this.#loadEveryLibrary();
    this.#plugins.askScopesOf(this.#libraries);
    await this.#provider.started(await this.#activateEveryPlugin());
    this.#starting.reach(this);
    if (this.#stop.requested) {
      return;
    }
    if (mode === HostMode.Serve) {
      await this.#serve();
    } else {
      await this.#provider.finished(await this.#runTheAction());
    }
  }

  /** Loads the plan's libraries in order. @throws Error for the first that will not load, which ends the run. */
  #loadEveryLibrary(): void {
    for (const library of this.#plan.libraries) {
      this.#libraries.push(loadDeclaredLibrary(this.#host, this.#standard, library.binary, library.declaration));
    }
  }

  /** Every plugin's outcome, in the plan's order, each one attempted. */
  async #activateEveryPlugin(): Promise<HostOutcome[]> {
    const outcomes: HostOutcome[] = [];
    for (const planned of this.#plan.plugins) {
      outcomes.push(await this.#plugins.activate(planned));
    }
    return outcomes;
  }

  /** Ticks at once, then at each time a tick answered, until a stop is requested. */
  async #serve(): Promise<void> {
    let next = await this.#provider.tick(Date.now());
    while (!this.#stop.requested) {
      if (next === undefined) {
        await this.#stop.arrived();
        return;
      }
      await this.#stop.until(next);
      if (this.#stop.requested) {
        return;
      }
      next = await this.#provider.tick(Date.now());
    }
  }

  async #runTheAction(): Promise<ActionEnding> {
    const { action_plugin: plugin, action_service: service, action_method: method } = this.#plan;
    const action =
      isSet(service) && isSet(method)
        ? this.#plugins.methodOf(plugin, service, method)
        : this.#plugins.actionOf(plugin, this.#plan.action_name);
    if (typeof action === "string") {
      return { failure: action };
    }
    try {
      return { result: await action(this.#plan.action_arguments) };
    } catch (error) {
      return { failure: messageOf(error) };
    }
  }

  async #stopTheRun(): Promise<number> {
    try {
      return await this.#provider.stop();
    } catch (error) {
      logEnding(this.#log, "stop", error);
      return failedRunExit;
    }
  }
}

/** Where a run tells the one who started it that `started` was told, and which run told it. */
class Starting {
  run: Run | undefined;
  readonly reached: Promise<void>;
  #reached: () => void = () => {};

  constructor() {
    this.reached = new Promise((resolve) => {
      this.#reached = resolve;
    });
  }

  reach(run: Run): void {
    this.run = run;
    this.#reached();
  }
}

/** One run of the program to its end, answering the code it exits with; it never rejects. */
async function runToTheEnd(options: RunHostOptions, stopSignal: AbortSignal, starting: Starting): Promise<number> {
  const log = options.log ?? consoleLogger;
  const stop = new StopRequest(stopSignal);
  let host: Host | undefined;
  try {
    const standard = loadStandard(options.standardLibraryPath);
    host = Host.create({
      edgeSource: EdgeSource.Capabilities,
      ...(options.coreLibraryPath === undefined ? {} : { coreLibraryPath: options.coreLibraryPath }),
      descriptionCheck: (description, definition) => standard.checkDescription(description, definition),
      log,
    });
    const hostLibrary = loadHostLibrary(host, standard, options.hostLibraryPath);
    const provider = HostProvider.of(hostLibrary, standard.serviceIds.host);
    let plan: HostPlan;
    try {
      plan = await provider.start(options.arguments ?? []);
    } catch (error) {
      logEnding(log, "start", error);
      return failedRunExit;
    }
    return await new Run(host, standard, hostLibrary, provider, plan, stop, options, starting).carryOut();
  } catch (error) {
    log.error(`The host program could not run: ${messageOf(error)}`, error);
    return failedRunExit;
  } finally {
    stop.dispose();
    await destroyQuietly(host, log);
  }
}

/**
 * Starts the library at `hostLibraryPath` as a host program's provider, as `weivel/host.h` of the standard describes,
 * in this process, and answers the running host once `started` has been told every plugin's outcome, or once the run
 * has ended without getting that far. Every decision is the provider's; the program reads the clock and carries its
 * answers out, and once `start` answered OK it calls `stop` last whatever happened. `options.signal` and the answer's
 * `stop()` are the same stop request.
 *
 * The libraries are unloaded, and the core destroyed, once the run has ended.
 */
export async function startHost(options: RunHostOptions): Promise<RunningHost> {
  const stopRequest = new AbortController();
  const requestStop = (): void => stopRequest.abort();
  const signal = options.signal;
  signal?.addEventListener("abort", requestStop, { once: true });
  if (signal?.aborted === true) {
    requestStop();
  }
  const starting = new Starting();
  const ended = runToTheEnd(options, stopRequest.signal, starting).finally(() => signal?.removeEventListener("abort", requestStop));
  await Promise.race([starting.reached, ended]);
  return {
    ended,
    service: <Service>(plugin: string, id: string) => starting.run?.serviceOf(plugin, id) as Service | undefined,
    stop: () => {
      requestStop();
      return ended;
    },
  };
}

/**
 * Runs the program as `startHost` does and answers the code it exits with once the run has ended: `stop`'s, or
 * `failedRunExit` when `start` did not answer OK, in which case nothing else is called.
 */
export async function runHost(options: RunHostOptions): Promise<number> {
  return (await startHost(options)).ended;
}
