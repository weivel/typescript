import { consoleLogger, type Logger } from "../context/index.js";
import { EdgeSource } from "../core/index.js";
import { messageOf } from "../host/activation-failure.js";
import { DescribedCallError, Host, type LoadedLibrary } from "../host/index.js";
import { HostMode, loadStandard, type Standard } from "../standard/index.js";
import { loadDeclaredLibrary, loadHostLibrary } from "./libraries.js";
import { failedRunExit, type ActionEnding, type HostOutcome, type HostPlan, type RunHostOptions } from "./model.js";
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

  constructor(host: Host, standard: Standard, hostLibrary: LoadedLibrary, provider: HostProvider, plan: HostPlan, stop: StopRequest, options: RunHostOptions) {
    this.#host = host;
    this.#standard = standard;
    this.#provider = provider;
    this.#plan = plan;
    this.#stop = stop;
    this.#log = options.log ?? consoleLogger;
    this.#plugins = new PluginRun(host, standard, options.entryExport ?? "default", this.#log);
    this.#libraries = [hostLibrary];
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

  async #carryOutThePlan(): Promise<void> {
    const mode = this.#plan.mode;
    if (mode !== HostMode.Serve && mode !== HostMode.Action) {
      throw new Error(`start answered the mode ${mode}, which this program does not run`);
    }
    if (!this.#loadEveryLibrary()) {
      return;
    }
    this.#plugins.askScopesOf(this.#libraries);
    const outcomes = await this.#activateEveryPlugin();
    if (outcomes === undefined) {
      return;
    }
    await this.#provider.started(outcomes);
    if (this.#stop.requested) {
      return;
    }
    if (mode === HostMode.Serve) {
      await this.#serve();
    } else {
      await this.#provider.finished(await this.#runTheAction());
    }
  }

  /** Loads the plan's libraries in order; false when a stop was requested first. */
  #loadEveryLibrary(): boolean {
    for (const library of this.#plan.libraries) {
      if (this.#stop.requested) {
        return false;
      }
      this.#libraries.push(loadDeclaredLibrary(this.#host, this.#standard, library.binary, library.declaration));
    }
    return !this.#stop.requested;
  }

  /** Every plugin's outcome in the plan's order, or undefined when a stop was requested before the last ended. */
  async #activateEveryPlugin(): Promise<HostOutcome[] | undefined> {
    const outcomes: HostOutcome[] = [];
    for (const planned of this.#plan.plugins) {
      outcomes.push(await this.#plugins.activate(planned));
      if (this.#stop.requested) {
        return undefined;
      }
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
    const action = this.#plugins.actionOf(this.#plan.action_plugin, this.#plan.action_name);
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

/**
 * Runs the library at `hostLibraryPath` as a host program's provider, as `weivel/host.h` of the standard describes,
 * and answers the code the program exits with: `stop`'s, or `failedRunExit` when `start` did not answer OK, in which
 * case nothing else is called. Every decision is the provider's; the program reads the clock and carries its answers
 * out, and once `start` answered OK it calls `stop` last whatever happened.
 *
 * The libraries are unloaded, and the core destroyed, once the run has ended.
 */
export async function runHost(options: RunHostOptions): Promise<number> {
  const log = options.log ?? consoleLogger;
  const stop = new StopRequest(options.signal);
  let host: Host | undefined;
  try {
    const standard = loadStandard(options.standardLibraryPath);
    host = Host.create({
      edgeSource: EdgeSource.Capabilities,
      ...(options.coreLibraryPath === undefined ? {} : { coreLibraryPath: options.coreLibraryPath }),
      descriptionCheck: (description) => standard.checkDescription(description),
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
    return await new Run(host, standard, hostLibrary, provider, plan, stop, options).carryOut();
  } catch (error) {
    log.error(`The host program could not run: ${messageOf(error)}`, error);
    return failedRunExit;
  } finally {
    stop.dispose();
    await host?.destroy();
  }
}
