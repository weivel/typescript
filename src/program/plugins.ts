import { lstatSync, readFileSync } from "node:fs";
import type { Logger } from "../context/index.js";
import type { Refusal } from "../core/index.js";
import { messageOf } from "../host/activation-failure.js";
import type { ActivationOutcome, Host, LoadedLibrary, Plugin, PluginAction } from "../host/index.js";
import { entryOnDisk, HostPluginState, type Standard } from "../standard/index.js";
import { alive } from "./alive.js";
import { isSet, type HostOutcome, type PlannedPlugin } from "./model.js";
import { textForC } from "./provider.js";
import { PluginScopes, type OpenedScope } from "./scopes.js";

interface RunPlugin {
  readonly planned: PlannedPlugin;
  readonly handle: bigint;
  readonly entry: Plugin;
  /** Its scope, once opened. */
  scope?: OpenedScope;
}

type Registered = { readonly plugin: RunPlugin; readonly detail?: undefined } | { readonly plugin?: undefined; readonly detail: string };

/** The standard's test of an entry, a regular file reached through no link, for the last step of its path. */
function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** A reason as an outcome's detail: set and not empty whenever a reason was given. */
function detailOf(reason: string | null | undefined): string | null {
  return reason === null || reason === undefined || reason === "" ? null : textForC(reason);
}

/**
 * The plan's plugins as one run activates them: each registered from its manifest, its scope opened, and activated
 * alone, in the plan's order, the next one's scope opened only once the activation before it ended; every one
 * released on the way out, then its scope.
 */
export class PluginRun {
  readonly #host: Host;
  readonly #standard: Standard;
  readonly #entryExport: string;
  readonly #log: Logger;
  readonly #scopes: PluginScopes;
  readonly #registered: RunPlugin[] = [];
  readonly #outcomes = new Map<string, HostOutcome>();

  constructor(host: Host, standard: Standard, entryExport: string, log: Logger) {
    this.#host = host;
    this.#standard = standard;
    this.#entryExport = entryExport;
    this.#log = log;
    this.#scopes = new PluginScopes(host, standard.serviceIds, log);
  }

  /** Asks each plugin's scope of the first of the run's `libraries` that serves `weivel.scope`. */
  askScopesOf(libraries: readonly LoadedLibrary[]): void {
    this.#scopes.askOf(libraries);
  }

  /** Activates one plugin of the plan and answers what became of it. */
  async activate(planned: PlannedPlugin): Promise<HostOutcome> {
    const outcome = await this.#activate(planned);
    this.#outcomes.set(planned.manifest, outcome);
    return outcome;
  }

  async #activate(planned: PlannedPlugin): Promise<HostOutcome> {
    const registered = this.#register(planned);
    if (registered.plugin === undefined) {
      return { manifest: planned.manifest, state: HostPluginState.Refused, detail: detailOf(registered.detail) };
    }
    const plugin = registered.plugin;
    const scope = await this.#scopes.open(plugin.handle, planned.manifest);
    if ("refused" in scope) {
      return { manifest: planned.manifest, state: HostPluginState.Refused, detail: detailOf(scope.refused) };
    }
    plugin.scope = scope;
    return this.#activateRegistered(plugin);
  }

  #register(planned: PlannedPlugin): Registered {
    let json: string;
    try {
      json = readFileSync(planned.manifest, "utf8");
    } catch (error) {
      return { detail: `its manifest ${planned.manifest} could not be read: ${messageOf(error)}` };
    }
    const loaded = this.#standard.loadManifest(json);
    if (loaded.value === undefined) {
      return { detail: loaded.refusal?.detail ?? `the standard refused its manifest ${planned.manifest}` };
    }
    const entry = entryOnDisk(planned.entry, isRegularFile(planned.entry), this.#entryExport);
    const answer = alive(this.#host.register(loaded.value, entry));
    if (answer.plugin === undefined) {
      return { detail: answer.refusal.detail ?? `the core refused to register it, code ${answer.refusal.code}` };
    }
    const plugin = { planned, handle: answer.plugin, entry };
    this.#registered.push(plugin);
    return { plugin };
  }

  async #activateRegistered(plugin: RunPlugin): Promise<HostOutcome> {
    const started = alive(this.#host.activate([plugin.handle]));
    if (started.refusal !== undefined) {
      return this.#refused(plugin, started.refusal);
    }
    const planRefusal = started.plan.refusals.find((refused) => refused.plugin === plugin.handle);
    if (planRefusal !== undefined) {
      return this.#refused(plugin, planRefusal.refusal);
    }
    const [outcome] = await started.outcomes;
    return outcome === undefined ? this.#refused(plugin, undefined) : this.#outcomeOf(plugin, outcome);
  }

  #refused(plugin: RunPlugin, refusal: Refusal | undefined): HostOutcome {
    return { manifest: plugin.planned.manifest, state: HostPluginState.Refused, detail: detailOf(refusal?.detail) };
  }

  /** @implNote A plugin quarantined for what its activate threw keeps the reason in its ledger row, not its outcome. */
  #outcomeOf(plugin: RunPlugin, outcome: ActivationOutcome): HostOutcome {
    const manifest = plugin.planned.manifest;
    if (outcome.state === "active") {
      return { manifest, state: HostPluginState.Activated, detail: null };
    }
    if (outcome.state === "refused") {
      return this.#refused(plugin, outcome.refusal);
    }
    const reason = outcome.refusal?.detail ?? this.#ledgerReason(plugin.handle);
    return { manifest, state: HostPluginState.Failed, detail: detailOf(reason) };
  }

  #ledgerReason(handle: bigint): string | null {
    const ledger = alive(this.#host.ledger());
    return ledger.rows.find((row) => row.plugin === handle)?.refusal.detail ?? null;
  }

  /** The action `name` of the plugin whose manifest the plan names `manifest`, or why there is none to run. */
  actionOf(manifest: string | null | undefined, name: string | null | undefined): PluginAction | string {
    if (!isSet(manifest) || !isSet(name)) {
      return "the plan names no action to run";
    }
    const plugin = this.#activated(manifest);
    if (plugin === undefined) {
      return `the plugin ${manifest} was not activated`;
    }
    const actions = plugin.entry.actions;
    const action = actions !== undefined && Object.hasOwn(actions, name) ? actions[name] : undefined;
    return typeof action === "function" ? action : `the plugin ${manifest} offers no action ${name}`;
  }

  /**
   * The method `method` of the service object the plugin whose manifest the plan names `manifest` itself registered
   * under `service`, or why there is none to run; the entry's actions are never read.
   */
  methodOf(manifest: string | null | undefined, service: string, method: string): PluginAction | string {
    if (!isSet(manifest)) {
      return "the plan names no action to run";
    }
    const plugin = this.#activated(manifest);
    if (plugin === undefined) {
      return `the plugin ${manifest} was not activated`;
    }
    const object = this.#host.serviceRegisteredBy(plugin.handle, service);
    if ((typeof object !== "object" && typeof object !== "function") || object === null) {
      return `the plugin ${manifest} does not provide ${service}`;
    }
    const offered = (object as Readonly<Record<string, unknown>>)[method];
    if (typeof offered !== "function") {
      return `the service ${service} of ${manifest} offers no method ${method}`;
    }
    return (actionArguments) => offered.call(object, actionArguments);
  }

  #activated(manifest: string): RunPlugin | undefined {
    const plugin = this.#registered.find((registered) => registered.planned.manifest === manifest);
    return plugin !== undefined && this.#outcomes.get(manifest)?.state === HostPluginState.Activated ? plugin : undefined;
  }

  /** Releases every plugin registered, the last first, and then its scope, each whatever became of the one before. */
  async releaseEvery(): Promise<void> {
    for (const plugin of [...this.#registered].reverse()) {
      await this.#host.release(plugin.handle).catch((error: unknown) => this.#log.error(`${plugin.planned.manifest} could not be released.`, error));
      try {
        plugin.scope?.release();
      } catch (error) {
        this.#log.error(`The scope of ${plugin.planned.manifest} could not be released.`, error);
      }
    }
  }
}
