import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { activationOrder, createHost, DISCARD, isPluginError, pluginError, proxyHandles, REAL_TIME } from "../engine/index.js";
import type { DiagnosticSink, Host, PluginRuntime } from "../engine/index.js";
import type { Plugin, PluginContext, PluginError, PluginManifest, Scheduler } from "../index.js";
import { ids, readDeployedManifests } from "./plugin-manifests.js";
import type { VocabularyEntry } from "./plugin-manifests.js";
import type { DeployedPlugin, ManifestScan } from "./plugin-manifests.js";
import { acquireLibrary, openLibrary, servicesOf } from "./library/index.js";
import type { LibraryDeclaration, LibraryPin, LoadedLibrary } from "./library/index.js";

/** How long one plugin's `activate` may take before it is quarantined. */
export const DEFAULT_ACTIVATE_TIMEOUT_MS = 10000;

/**
 * How long one plugin's `deactivate` may take before the host stops waiting for it.
 *
 * @remarks
 * Its own budget rather than the activate one: a `deactivate` runs on shutdown, where the whole
 * home is waiting on the slowest plugin, while an `activate` runs on load with nothing yet to lose.
 */
export const DEFAULT_DEACTIVATE_TIMEOUT_MS = 5000;

/** What the host needs from whoever starts it. */
export interface PluginHostOptions {
  /** The app id plugins see on the host descriptor, which is the HOME this host is loaded into. */
  app: string;
  /**
   * The spisor applications this host hosts, which is what an artifact's `targets` is matched against.
   *
   * @remarks
   * NOT the same thing as {@link app}, and conflating them is the trap this field exists to avoid.
   * `app` names the home a host is loaded into, `claude` or `opencode` or `forebay`; this names the
   * product, so one product loaded into four homes declares the same single application in all four.
   * Absent means this host hosts `[app]`; an explicit empty list hosts every application.
   */
  applications?: string[];
  /** The home's plugin directory, normally `<home>/plugin`. */
  pluginDir: string;
  /** Surface ids this host renders. */
  surfaces?: string[];
  /**
   * The capability categories this host understands.
   *
   * @remarks
   * Absent means unverifiable, not empty: a host that declares nothing gets no diagnostics rather
   * than having every id it was handed called unknown. Pass the typed keys of whatever this host
   * actually renders, which is what turns the check into "does THIS host understand it".
   */
  vocabulary?: ReadonlyArray<VocabularyEntry>;
  /**
   * The bare service ids any plugin may register, beyond ids namespaced by the registering plugin.
   *
   * @remarks
   * Absent means an empty vocabulary here, the opposite of {@link vocabulary}, because a bare id
   * claims a shared contract and a host that names none is saying no such contract exists.
   */
  wellKnownServices?: ReadonlyArray<VocabularyEntry>;
  /**
   * Services the host itself implements, offered to every plugin.
   *
   * @remarks
   * How a plugin reaches behaviour belonging to a library it may not link: the host links it once
   * and hands over a typed handle, rather than every plugin carrying a private copy. Registered
   * before the first `activate`, so a plugin asking during activation finds it.
   */
  services?: ReadonlyArray<{ id: string; implementation: unknown }>;
  /**
   * C libraries to acquire, verify and open, each declared service of which is offered like {@link services}.
   *
   * @remarks
   * A library that cannot be acquired or opened costs only its own services: its refusal joins
   * {@link LoadedHost.quarantined}, and a plugin requiring one of its services is then refused the
   * normal way, while every other library and plugin still starts.
   */
  libraries?: readonly LibraryPin[];
  /** Where acquired libraries are cached. Defaults to {@link defaultLibraryCache}. */
  libraryCache?: string;
  /**
   * The one clock every deadline comes from: activate, deactivate and the engine's own waits.
   *
   * @remarks
   * Defaults to real time. A test passes a manual one so a deadline costs no wall clock.
   */
  scheduler?: Scheduler;
  /** Where the engine reports what it ignored or refused. Defaults to discarding. */
  diagnostics?: DiagnosticSink;
  /** How long one `activate` may take. Defaults to {@link DEFAULT_ACTIVATE_TIMEOUT_MS}. */
  activateTimeoutMs?: number;
  /** How long one `deactivate` may take. Defaults to {@link DEFAULT_DEACTIVATE_TIMEOUT_MS}. */
  deactivateTimeoutMs?: number;
  /**
   * Builds the per-plugin runtime.
   *
   * @remarks
   * Injected rather than built here, because the api carries no core submodule: whoever starts
   * the host passes core's `createPluginRuntime`.
   */
  runtimeFor: (manifest: PluginManifest) => PluginRuntime;
  /** Reads the home. Defaults to {@link readDeployedManifests}, and is replaced in tests. */
  scan?: ManifestScan;
  /** Imports one entry module. Defaults to a dynamic import, and is replaced in tests. */
  importEntry?: (entryPath: string) => Promise<unknown>;
}

/** A running host: what started, what did not, and how to shut it down. */
export interface LoadedHost {
  /** The clock every deadline of this host comes from; hand it to {@link callCapability} so a call keeps time on the same one. */
  scheduler: Scheduler;
  /** The engine's host, which owns the capabilities, the services and the ledger. */
  host: Host;
  /** Plugin ids that activated cleanly, in activation order. */
  started: string[];
  /**
   * One error per plugin that could not be loaded, each naming the plugin and the fix, and one per
   * library that could not be acquired or opened, naming its release or its id.
   */
  quarantined: PluginError[];
  /** Every plugin whose manifest validated, as the scan found it on disk. */
  deployed: DeployedPlugin[];
  /**
   * Deactivates every started plugin, newest first, each under its own deadline.
   *
   * @remarks
   * Calling it again waits on the shutdown already running rather than deactivating anything a
   * second time.
   */
  stop: () => Promise<void>;
}

function isPlugin(candidate: unknown): candidate is Plugin {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    "activate" in candidate &&
    typeof candidate.activate === "function" &&
    "deactivate" in candidate &&
    typeof candidate.deactivate === "function"
  );
}

function isPluginClass(candidate: unknown): candidate is new () => Plugin {
  return typeof candidate === "function" && isPlugin(candidate.prototype);
}

/**
 * Reads a plugin out of an imported entry module.
 *
 * @remarks
 * Only the default export counts (design 7.5): an object implementing `Plugin`, or a class whose
 * prototype does, constructed with no arguments. A named `activate` and `deactivate` are ignored,
 * so a module that exports a broken default is rejected rather than papered over by whatever else
 * its namespace happens to expose.
 *
 * @throws whatever the class constructor throws, which the caller turns into a quarantine
 */
function asPlugin(module: unknown): Plugin | null {
  const entry = typeof module === "object" && module !== null && "default" in module ? module.default : undefined;
  if (isPluginClass(entry)) return new entry();
  return isPlugin(entry) ? entry : null;
}

function detailOf(error: unknown): string {
  if (isPluginError(error) && error.detail) return error.detail;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message ? message : String(error);
}

/**
 * Attributes a caught failure to the plugin the host was calling.
 *
 * @remarks
 * A caught {@link PluginError} carries whatever `pluginId` its thrower chose, and the thrower
 * may be another plugin's service. Its detail and fix are worth keeping, its attribution is not:
 * the quarantine belongs to the plugin whose call failed.
 */
function errorFor(pluginId: string, error: unknown, fix: string): PluginError {
  const carried = isPluginError(error) && error.fix ? error.fix : fix;
  return pluginError(pluginId, detailOf(error), carried);
}

function refusalBeforeOrdering(host: Host, deployed: DeployedPlugin): PluginError | null {
  const { manifest, entryPath } = deployed;
  const unsupported = host.supports(manifest);
  if (unsupported) return unsupported;
  if (entryPath) return null;
  return pluginError(
    manifest.id,
    manifest.entry ? "declares an entry but no bundle is deployed beside its manifest" : "declares no entry, so there is nothing to activate",
    manifest.entry ? "deploy the plugin again so its bundle lands beside the sidecar" : "add \"entry\": \"dist/index.js\" to plugin.json if this plugin has capabilities",
  );
}

type Activatable = DeployedPlugin & { entryPath: string };

/** @returns false once the plugin is quarantined, so a refusal knowable now never counts as a provider. */
function isActivatable(host: Host, quarantined: PluginError[], deployed: DeployedPlugin): deployed is Activatable {
  const refusal = refusalBeforeOrdering(host, deployed);
  if (refusal) quarantine(host, quarantined, deployed.manifest, refusal);
  return refusal === null && typeof deployed.entryPath === "string";
}

/**
 * Quarantines a plugin before its context ever opened.
 *
 * @remarks
 * `recordDeclared` runs first so the ledger entry carries what the manifest actually declared
 * (capabilities, permissions) alongside the error, rather than a blank entry a reader would
 * mistake for "declared nothing". `markBroken` runs after, so its status and error survive:
 * `recordDeclared` resets status to `activating` and clears any error, and reversing the order
 * would silently undo the quarantine.
 */
function quarantine(host: Host, quarantined: PluginError[], manifest: PluginManifest, error: PluginError): void {
  host.ledger.recordDeclared(manifest);
  host.markBroken(manifest.id, error);
  quarantined.push(error);
}

async function callWithDeadline<T>(
  scheduler: Scheduler,
  pluginId: string,
  timeoutMs: number,
  detail: string,
  fix: string,
  work: () => Promise<T>,
): Promise<T> {
  let cancelDeadline = (): void => {};
  const expiry = new Promise<never>((_resolve, reject) => {
    cancelDeadline = scheduler.schedule(() => reject(pluginError(pluginId, detail, fix)), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(work), expiry]);
  } finally {
    cancelDeadline();
  }
}

async function withTimeout(scheduler: Scheduler, pluginId: string, timeoutMs: number, run: () => void | Promise<void>): Promise<void> {
  await callWithDeadline(
    scheduler,
    pluginId,
    timeoutMs,
    `activate did not finish within ${timeoutMs}ms`,
    "return from activate promptly and do slow work in the background, or raise the host's activate timeout",
    async () => { await Promise.resolve(run()); },
  );
}

async function callDeactivate(scheduler: Scheduler, pluginId: string, timeoutMs: number, plugin: Plugin): Promise<void> {
  await callWithDeadline(
    scheduler,
    pluginId,
    timeoutMs,
    `deactivate did not finish within ${timeoutMs}ms`,
    "return from deactivate promptly and do slow work in the background, or raise the host's deactivate timeout",
    async () => { await Promise.resolve(plugin.deactivate()); },
  );
}

/**
 * Stops a plugin that is about to be quarantined.
 *
 * @remarks
 * `activate` ran, so the plugin's timers, watchers and child processes are live, and quarantine
 * drops it from the started list where `stop` would otherwise have reached it. A `deactivate` that
 * throws or hangs is swallowed: the quarantine that follows is already the answer to it.
 *
 * On the timeout path this is a trade rather than a clean stop. `activate` was abandoned, not
 * cancelled, so `deactivate` can run before the resources it means to release exist, throw into
 * the swallow, and then the abandoned `activate` finishes and starts the very thing that was meant
 * to be stopped. It is still worth calling: the plugin's context is fenced by then, so whatever
 * starts cannot register itself back into the host, and the common case (an `activate` that threw
 * after taking resources) is stopped properly.
 */
async function stopBeforeQuarantine(scheduler: Scheduler, pluginId: string, timeoutMs: number, plugin: Plugin): Promise<void> {
  try {
    await callDeactivate(scheduler, pluginId, timeoutMs, plugin);
  } catch {
    return;
  }
}

/** The per-user library cache: `%LOCALAPPDATA%` on Windows, `$XDG_CACHE_HOME` or `~/.cache` elsewhere. */
export function defaultLibraryCache(): string {
  const base = process.platform === "win32" ? process.env.LOCALAPPDATA : process.env.XDG_CACHE_HOME;
  return join(base || join(homedir(), ".cache"), "weivel", "libraries");
}

interface OpenedLibraries {
  libraries: LoadedLibrary[];
  services: Array<{ id: string; implementation: unknown }>;
}

const EMBEDDING_HOST = "the embedding host";

function closeAll(libraries: readonly LoadedLibrary[]): void {
  for (const library of libraries) library.close();
}

function collisionRefusal(declaration: LibraryDeclaration, pin: LibraryPin, serviceId: string, existing: string): PluginError {
  return pluginError(
    declaration.id,
    `service "${serviceId}" is offered by both ${existing} and library ${declaration.id} (${pin.repository}@${pin.tag}), so the library is refused with every service it offers`,
    `rename the service in one library's library.json, or stop ${existing} offering "${serviceId}"`,
  );
}

/**
 * Acquires and opens every pinned library, keeping each whose service ids nothing earlier offers.
 *
 * @remarks
 * The host registry replaces a service registered twice, so a collision is refused here, before
 * anything is registered: the embedder's own services win, then libraries in pin order. A library
 * with one colliding service offers none of them and is closed again, because a library is one
 * release unit and a partial offer would split it silently.
 */
async function openLibraries(
  pins: readonly LibraryPin[],
  cacheDir: string,
  embedderServiceIds: readonly string[],
  quarantined: PluginError[],
): Promise<OpenedLibraries> {
  const opened: OpenedLibraries = { libraries: [], services: [] };
  const providers = new Map<string, string>(embedderServiceIds.map((id) => [id, EMBEDDING_HOST]));
  for (const pin of pins) {
    try {
      const { declaration, binaryPath } = await acquireLibrary(pin, cacheDir);
      const library = openLibrary(binaryPath, declaration);
      const offered = servicesOf(library, declaration);
      const colliding = offered.find((service) => providers.has(service.id));
      if (colliding) {
        library.close();
        quarantined.push(collisionRefusal(declaration, pin, colliding.id, providers.get(colliding.id) as string));
        continue;
      }
      for (const service of offered) providers.set(service.id, `library ${declaration.id} (${pin.repository}@${pin.tag})`);
      opened.libraries.push(library);
      opened.services.push(...offered);
    } catch (error) {
      quarantined.push(isPluginError(error) ? error : pluginError(`${pin.repository}@${pin.tag}`, detailOf(error), "check the library pin and its release"));
    }
  }
  return opened;
}

/**
 * Loads every plugin deployed in a home: manifests first, then dependency order, then one
 * `activate` at a time under its own timeout.
 *
 * @remarks
 * Nothing here branches on a plugin id, and nothing can. Every failure ends as a quarantine naming
 * the plugin and the fix, so one bad plugin costs its own capabilities and nothing else: a cycle
 * quarantines only its members, a throwing `activate` quarantines only its own plugin, and a
 * hanging one is cut loose at the timeout with the host still up. A plugin quarantined once
 * `activate` has been entered gets its `deactivate` called first, since it may have started work
 * the host would otherwise leave running with nothing holding it.
 */
export async function startPlugins(options: PluginHostOptions): Promise<LoadedHost> {
  const timeoutMs = options.activateTimeoutMs ?? DEFAULT_ACTIVATE_TIMEOUT_MS;
  const stopMs = options.deactivateTimeoutMs ?? DEFAULT_DEACTIVATE_TIMEOUT_MS;
  const diagnostics = options.diagnostics ?? DISCARD;
  const scheduler = options.scheduler ?? REAL_TIME;
  const importEntry = options.importEntry ?? (async (entryPath: string) => import(pathToFileURL(entryPath).href));
  const scan = options.scan ?? readDeployedManifests(options.pluginDir, options.wellKnownServices);

  const quarantined: PluginError[] = [];
  const embedderServices = options.services ?? [];
  const opened = await openLibraries(
    options.libraries ?? [],
    options.libraryCache ?? defaultLibraryCache(),
    embedderServices.map((service) => service.id),
    quarantined,
  );
  const services = [...embedderServices, ...opened.services];
  try {

    const host = createHost({
      app: options.app,
      applications: options.applications,
      surfaces: options.surfaces ?? [],
      vocabulary: ids(options.vocabulary),
      wellKnownServices: ids(options.wellKnownServices),
      scheduler,
      handles: proxyHandles(diagnostics),
      diagnostics,
    });
    for (const { id, implementation } of services) {
      host.provideService(id, implementation);
    }

    const started: string[] = [];
    const plugins = new Map<string, Plugin>();

    for (const failure of scan.failed) {
      host.markBroken(failure.pluginId, failure);
      quarantined.push(failure);
    }

    const activatable = scan.loaded.filter((plugin) => isActivatable(host, quarantined, plugin));
    const byId = new Map<string, Activatable>(activatable.map((plugin) => [plugin.manifest.id, plugin]));
    const plan = activationOrder(
      activatable.map((plugin) => plugin.manifest),
      services.map((service) => service.id),
    );
    for (const cycle of plan.cycles) {
      for (const pluginId of cycle) {
        const manifest = byId.get(pluginId)?.manifest;
        if (!manifest) continue;
        quarantine(host, quarantined, manifest, pluginError(
          pluginId,
          `is in a dependency cycle: ${cycle.join(" -> ")} -> ${cycle[0]}`,
          "break the cycle by removing one plugin's entry from services.consumes in its plugin.json",
        ));
      }
    }

    for (const refusal of plan.refusals) {
      const manifest = byId.get(refusal.pluginId)?.manifest;
      if (manifest) quarantine(host, quarantined, manifest, refusal);
    }

    for (const pluginId of plan.order) {
      const deployed = byId.get(pluginId);
      if (!deployed) continue;
      const { manifest, entryPath } = deployed;

      let plugin: Plugin | null;
      try {
        plugin = asPlugin(await importEntry(entryPath));
      } catch (error) {
        const failure = errorFor(pluginId, error, "rebuild the plugin: its deployed bundle could not be imported, or its default class could not be constructed");
        quarantine(host, quarantined, manifest, failure);
        continue;
      }

      if (!plugin) {
        const error = pluginError(
          pluginId,
          "its entry module exports no plugin",
          "export default an object implementing Plugin, or a class implementing it that takes no constructor arguments",
        );
        quarantine(host, quarantined, manifest, error);
        continue;
      }

      let context: PluginContext;
      try {
        context = host.contextFor(manifest, options.runtimeFor(manifest));
      } catch (error) {
        const failure = errorFor(pluginId, error, "fix the plugin's own configuration; its runtime could not be built");
        quarantine(host, quarantined, manifest, failure);
        continue;
      }

      try {
        await withTimeout(scheduler, pluginId, timeoutMs, () => plugin.activate(context));
      } catch (error) {
        const failure = errorFor(pluginId, error, "fix the error activate threw, or disable the plugin");
        await stopBeforeQuarantine(scheduler, pluginId, stopMs, plugin);
        host.markBroken(pluginId, failure);
        quarantined.push(failure);
        continue;
      }

      const mismatch = host.verifyActivation(manifest);
      if (mismatch) {
        await stopBeforeQuarantine(scheduler, pluginId, stopMs, plugin);
        host.markBroken(pluginId, mismatch);
        quarantined.push(mismatch);
        continue;
      }

      plugins.set(pluginId, plugin);
      started.push(pluginId);
    }

    async function shutDown(): Promise<void> {
      for (const pluginId of [...started].reverse()) {
        const plugin = plugins.get(pluginId);
        if (!plugin) continue;
        try {
          await callDeactivate(scheduler, pluginId, stopMs, plugin);
        } catch (error) {
          host.markBroken(pluginId, errorFor(pluginId, error, "fix the error deactivate threw; the plugin was stopped anyway"));
          continue;
        }
        host.release(pluginId);
      }
      closeAll(opened.libraries);
    }

    let shutdown: Promise<void> | null = null;
    return {
      host,
      scheduler,
      started,
      quarantined,
      deployed: scan.loaded,
      stop: async () => {
        shutdown ??= shutDown();
        await shutdown;
      },
    };
  } catch (error) {
    closeAll(opened.libraries);
    throw error;
  }
}

/** How long a capability read may take. */
export const DEFAULT_CALL_TIMEOUT_MS = 10000;

/** How long a capability action may take, since one may do real work such as a multi-file restore. */
export const DEFAULT_INVOKE_TIMEOUT_MS = 600000;

/** What one bounded capability call produced. */
export type CapabilityCall<T> = { ok: true; value: T } | { ok: false; error: PluginError };

/**
 * Calls into a plugin with a deadline.
 *
 * @remarks
 * Plugins run in this process, so a capability that hangs or throws would otherwise be the host's
 * problem. A failure here is NOT a quarantine: a slow screen read says nothing about the plugin's
 * services, and dropping its registrations over one call would take out far more than the surface
 * that failed. Every call always returns a result object, never throws.
 *
 * @param pluginId - the plugin being called
 * @param label - what was being called, for example `screens.read`, which appears in the error
 * @param timeoutMs - deadline in milliseconds
 * @param call - the async work to perform
 * @param scheduler - the clock the deadline comes from, real time by default; pass `loaded.scheduler` so the
 * call keeps time on the host's own clock
 */
export async function callCapability<T>(
  pluginId: string,
  label: string,
  timeoutMs: number,
  call: () => Promise<T>,
  scheduler: Scheduler = REAL_TIME,
): Promise<CapabilityCall<T>> {
  try {
    const value = await callWithDeadline(
      scheduler,
      pluginId,
      timeoutMs,
      `${label} did not answer within ${timeoutMs}ms`,
      "make the call return promptly, or check whether the plugin is waiting on something that never arrives",
      call,
    );
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: errorFor(pluginId, error, `fix what ${label} threw, or disable the plugin`) };
  }
}

/** One plugin's whole relationship record, in the shape a surface renders. */
export interface PluginLedgerRow {
  /** The plugin this row describes. */
  pluginId: string;
  /** Where the plugin stands: activating, active, broken or stopped. */
  status: string;
  /** Capability ids its manifest declared. */
  capabilitiesDeclared: string[];
  /** Capability ids it actually provided. */
  capabilities: string[];
  /** What it offers other plugins and what it asked of them. */
  services: {
    /** Service ids it registered. */
    provides: string[];
    /** Service ids it asked for, whether or not anything answered. */
    consumes: string[];
  };
  /** Event topics it subscribed to. */
  topics: string[];
  /** Permissions its manifest declares. */
  permissions: string[];
  /** Service ids it consumed that nothing in this home provides. */
  unresolved: string[];
  /** Why it is broken, when it is. */
  error?: {
    /** What went wrong. */
    detail: string;
    /** How to fix it. */
    fix: string;
  };
}

/**
 * Renders the host's ledger as rows.
 *
 * @remarks
 * The ledger is kept as the relationships are made, because a relationship is only observable at
 * the moment it happens. `unresolved` asks the live registry for each consumed id instead, since
 * whether a consumed service is answered depends on what is registered right now and that changes
 * as plugins are enabled and disabled.
 */
export function ledgerRows(loaded: LoadedHost): PluginLedgerRow[] {
  const entries = loaded.host.ledger.entries();
  return entries.map((entry) => {
    const row: PluginLedgerRow = {
      pluginId: entry.pluginId,
      status: entry.status,
      capabilitiesDeclared: entry.capabilitiesDeclared,
      capabilities: entry.capabilitiesProvided,
      services: { provides: entry.servicesProvided, consumes: entry.servicesConsumed },
      topics: entry.topics,
      permissions: entry.permissions,
      unresolved: entry.servicesConsumed.filter((serviceId) => loaded.host.service(serviceId) === undefined),
    };
    if (entry.error) row.error = entry.error;
    return row;
  });
}
