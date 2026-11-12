import { API_VERSION } from "../index.js";
import type { HostDescriptor, PluginContext, PluginError, PluginManifest, Scheduler } from "../index.js";
import { compatibility } from "./compatibility.js";
import type { ConstraintEntry } from "./constraints.js";
import { contextOf } from "./context.js";
import type { CapabilityEvent, CapabilityListener, ConsumedCapabilities, PluginRuntime, RuntimeEvents } from "./context.js";
import { DISCARD } from "./diagnostics.js";
import type { DiagnosticSink } from "./diagnostics.js";
import { pluginError } from "./errors.js";
import { factsOf } from "./facts.js";
import type { ManifestFacts } from "./facts.js";
import type { Handles } from "./handles.js";
import { PluginLedger } from "./ledger.js";
import type { DeclarationRefusal, LedgerRow } from "./ledger.js";
import { ServiceHub, stoppedWaiting } from "./registry.js";
import type { Fence, ServiceAttempt } from "./registry.js";
import { readOffer, readRequirement } from "./requirements.js";

export interface HostOptions {
  /** The HOME this host is loaded into, which every plugin reads on its descriptor. */
  app: string;
  /**
   * The applications this host hosts, which targeting is matched against.
   *
   * @remarks
   * Absent means `[app]`; an explicit `[]` means every application (decision 3).
   */
  applications?: string[];
  api?: number;
  surfaces?: string[];
  /** Capability ids this host understands. Absent or empty means it verifies and reports none. */
  vocabulary?: string[];
  wellKnownServices?: string[];
  constraintVocabulary?: ConstraintEntry[];
  /** Defaults to real time through `setTimeout`. */
  scheduler?: Scheduler;
  handles?: Handles;
  /** Defaults to discarding (decision 6). */
  diagnostics?: DiagnosticSink;
}

export interface CapabilityRecord {
  pluginId: string;
  implementation: unknown;
}

export interface HostLedger {
  entries(): LedgerRow[];
  entry(pluginId: string): LedgerRow | undefined;
  recordDeclared(manifest: PluginManifest): void;
  /** Every service or capability a plugin reached for without declaring it, once per kind, plugin and id, in the order reported. */
  refusals(): DeclarationRefusal[];
}

/**
 * The host side of the plugin system: it opens contexts, collects what plugins provide, and keeps
 * the ledger.
 *
 * @remarks
 * Nothing here branches on a plugin id: a capability id and a service id are the only dispatch keys
 * a host has, which keeps it ignorant of every specific plugin.
 */
export interface Host {
  readonly descriptor: HostDescriptor;
  readonly ledger: HostLedger;
  /** Why this host cannot load the manifest, or null when it can. */
  supports(manifest: PluginManifest): PluginError | null;
  /** Opens one plugin's context, lifting any fence it was under. */
  contextFor(manifest: PluginManifest, runtime: PluginRuntime): PluginContext;
  /** Why what the plugin provided disagrees with what it declared, or null after marking it active. */
  verifyActivation(manifest: PluginManifest): PluginError | null;
  /** Every implementation of a capability, in the order provided, whether or not its activation is verified yet. */
  capability(id: string): CapabilityRecord[];
  service(id: string): unknown | undefined;
  /** Offers a service the host itself implements; owned by no plugin, so no quarantine takes it. */
  provideService(id: string, service: unknown): void;
  /** Quarantines a plugin: what it provided goes, its context is fenced, the host stays up. */
  markBroken(pluginId: string, error: PluginError): void;
  release(pluginId: string): void;
}

/**
 * Builds a host whose registry, ledger and diagnostics are its own.
 *
 * @remarks
 * Nothing is module state, so two hosts in one process share nothing (design 7.11).
 */
export function createHost(options: HostOptions): Host {
  return new HostState(options).surface();
}

const MAX_TIMER_DELAY_MILLIS = 2 ** 31 - 1;

/**
 * The default clock: real time through `setTimeout`.
 *
 * @implNote `setTimeout` clamps a delay above 2^31-1 ms, or NaN, to about 1 ms, which would fire a
 * long deadline almost at once. A non-finite delay therefore schedules nothing, and a long one
 * chains timers until the whole delay has elapsed.
 */
export const REAL_TIME: Scheduler = Object.freeze({
  schedule: (task: () => void, delayMillis: number) => {
    if (!Number.isFinite(delayMillis)) return () => {};
    let current: ReturnType<typeof setTimeout> | undefined;
    const arm = (remainingMillis: number): void => {
      const step = Math.min(remainingMillis, MAX_TIMER_DELAY_MILLIS);
      current = setTimeout(() => (remainingMillis > step ? arm(remainingMillis - step) : task()), step);
    };
    arm(delayMillis);
    return () => clearTimeout(current);
  },
});

function applicationsOf(options: HostOptions): string[] {
  if (options.applications !== undefined) return [...options.applications];
  return options.app === "" ? [] : [options.app];
}

class HostState {
  private readonly descriptor: HostDescriptor;
  private readonly applications: readonly string[];
  private readonly known: readonly string[];
  private readonly diagnostics: DiagnosticSink;
  private readonly ledger = new PluginLedger();
  private readonly hub: ServiceHub;
  private readonly capabilities = new Map<string, CapabilityRecord[]>();
  private readonly verified = new Map<string, CapabilityRecord[]>();
  private readonly capabilityWatchers = new Map<string, Set<CapabilityWatcher>>();
  private readonly disposers = new Map<string, Set<() => void>>();
  private readonly revoked = new Set<string>();
  private readonly importNames = new Map<string, string>();

  constructor(options: HostOptions) {
    this.descriptor = { api: options.api ?? API_VERSION, app: options.app, surfaces: [...(options.surfaces ?? [])] };
    this.applications = applicationsOf(options);
    this.known = [...(options.vocabulary ?? [])];
    this.diagnostics = options.diagnostics ?? DISCARD;
    this.hub = new ServiceHub({
      scheduler: options.scheduler ?? REAL_TIME,
      diagnostics: this.diagnostics,
      handles: options.handles,
      wellKnown: options.wellKnownServices,
      vocabulary: options.constraintVocabulary,
      namespaceOf: (pluginId) => this.importNames.get(pluginId) ?? pluginId,
      mismatch: (consumerId, serviceId, provider, owner) => this.refuseWrongProvider(consumerId, serviceId, provider, owner),
      recorder: {
        provided: (pluginId, serviceId) => this.ledger.recordServiceProvided(pluginId, serviceId),
        consumed: (pluginId, serviceId) => this.ledger.recordServiceConsumed(pluginId, serviceId),
      },
    });
  }

  surface(): Host {
    return {
      descriptor: this.descriptor,
      ledger: {
        entries: () => this.ledger.entries(),
        entry: (pluginId) => this.ledger.entry(pluginId),
        recordDeclared: (manifest) => {
        this.recordDeclared(manifest);
      },
        refusals: () => this.ledger.refusals(),
      },
      supports: (manifest) => compatibility({ applications: this.applications, api: this.descriptor.api }, factsOf(manifest))?.refusal ?? null,
      contextFor: (manifest, runtime) => this.contextFor(manifest, runtime),
      verifyActivation: (manifest) => this.verifyActivation(manifest),
      capability: (id) => (this.capabilities.get(id) ?? []).map((record) => ({ ...record })),
      service: (id) => this.hub.get(id),
      provideService: (id, service) => this.hub.hostService(id, service),
      markBroken: (pluginId, error) => {
        this.strip(pluginId);
        this.ledger.recordStatus(pluginId, "broken", { detail: error.detail, fix: error.fix });
      },
      release: (pluginId) => {
        this.strip(pluginId);
        this.ledger.recordStatus(pluginId, "stopped");
      },
    };
  }

  private recordDeclared(manifest: PluginManifest): ManifestFacts {
    const facts = factsOf(manifest);
    this.ledger.recordDeclared(facts.id, facts.capabilitiesProvided, facts.permissions);
    return facts;
  }

  private contextFor(manifest: PluginManifest, runtime: PluginRuntime): PluginContext {
    const facts = this.recordDeclared(manifest);
    const pluginId = facts.id;
    const bound = boundProviders(manifest);
    this.revoked.delete(pluginId);
    this.importNames.set(pluginId, importNameOf(manifest, pluginId));
    return contextOf({
      manifest,
      host: this.descriptor,
      runtime,
      registry: this.hub.forConsumer(pluginId, this.fenceFor(pluginId, declaredServices(manifest), bound), (serviceId) => bound.get(serviceId)),
      events: this.recording(pluginId, runtime.events),
      provide: (capabilityId, implementation) => this.provide(pluginId, capabilityId, implementation),
      capabilities: this.consumed(pluginId, declaredCapabilities(facts)),
    });
  }

  /**
   * @implNote A plugin's implementations reach its consumers here and not at `provide`: until this
   * check passes the host may still quarantine the plugin, and a consumer must never be handed an
   * implementation about to be withdrawn for a declaration mismatch (invariant 14). They join in the
   * order activations are verified, which is the order a consumer's answer keeps.
   */
  private verifyActivation(manifest: PluginManifest): PluginError | null {
    const { id, capabilitiesProvided: declared } = factsOf(manifest);
    const provided = this.ledger.entry(id)?.capabilitiesProvided ?? [];
    const missing = declared.filter((capability) => !provided.includes(capability));
    if (missing.length > 0) {
      return pluginError(
        id,
        `capabilities declared but never provided: ${missing.join(", ")}`,
        `call context.provide(context.capability("${missing[0]}"), ...) in activate, or remove it from capabilities.provides in plugin.json`,
      );
    }
    const extra = provided.filter((capability) => !declared.includes(capability));
    if (extra.length > 0) {
      return pluginError(id, `capabilities provided but never declared: ${extra.join(", ")}`, `add "${extra[0]}" to capabilities.provides in plugin.json`);
    }
    this.ledger.recordStatus(id, "active");
    this.admitVerified(id);
    return null;
  }

  private provide(pluginId: string, capabilityId: string, implementation: unknown): void {
    if (this.refuseLate(pluginId, "a late provision of capability", capabilityId)) return;
    if (this.known.length > 0 && !this.known.includes(capabilityId)) {
      this.diagnostics(`ignored unknown capability "${capabilityId}" from ${pluginId}`);
    }
    const records = this.capabilities.get(capabilityId) ?? [];
    if (records.some((record) => record.pluginId === pluginId)) {
      throw pluginError(pluginId, `provided capability "${capabilityId}" twice`, "call context.provide once per capability in activate");
    }
    records.push({ pluginId, implementation });
    this.capabilities.set(capabilityId, records);
    this.ledger.recordCapabilityProvided(pluginId, capabilityId);
  }

  private strip(pluginId: string): void {
    this.revoked.add(pluginId);
    this.withdrawVerified(pluginId);
    for (const [id, records] of [...this.capabilities]) {
      const kept = records.filter((record) => record.pluginId !== pluginId);
      if (kept.length === 0) this.capabilities.delete(id);
      else this.capabilities.set(id, kept);
    }
    for (const dispose of [...(this.disposers.get(pluginId) ?? [])]) dispose();
    this.disposers.delete(pluginId);
    this.hub.release(pluginId);
  }

  /**
   * @implNote The declaration is checked before lateness, as for services: an undeclared call is
   * refused and reported as undeclared whether or not the plugin still runs. A late `all` is let
   * through, since it installs nothing, while a late `watch` is inert and goes to the diagnostics
   * only, the way a late service call does.
   */
  private consumed(pluginId: string, declared: ReadonlySet<string>): ConsumedCapabilities {
    return {
      all: (id) => {
        if (!declared.has(id)) {
          this.refuseUndeclaredCapability(pluginId, id);
          return [];
        }
        return (this.verified.get(id) ?? []).map((record) => record.implementation);
      },
      watch: (id, listener) => {
        if (!declared.has(id)) {
          this.refuseUndeclaredCapability(pluginId, id);
          return () => {};
        }
        if (this.refuseLate(pluginId, "a late watch of capability", id)) return () => {};
        return this.tracked(pluginId, this.installCapabilityWatcher(id, listener));
      },
    };
  }

  private installCapabilityWatcher(id: string, listener: CapabilityListener): () => void {
    const watcher: CapabilityWatcher = { listener };
    const installed = this.capabilityWatchers.get(id) ?? new Set<CapabilityWatcher>();
    installed.add(watcher);
    this.capabilityWatchers.set(id, installed);
    return () => {
      installed.delete(watcher);
      if (installed.size === 0 && this.capabilityWatchers.get(id) === installed) this.capabilityWatchers.delete(id);
    };
  }

  private admitVerified(pluginId: string): void {
    for (const [id, records] of [...this.capabilities]) {
      for (const record of records) {
        if (record.pluginId === pluginId && this.admit(id, record)) this.notifyCapabilityWatchers(id, record.implementation, "provide");
      }
    }
  }

  private admit(id: string, record: CapabilityRecord): boolean {
    const records = this.verified.get(id) ?? [];
    if (records.includes(record)) return false;
    records.push(record);
    this.verified.set(id, records);
    return true;
  }

  private withdrawVerified(pluginId: string): void {
    for (const [id, records] of [...this.verified]) {
      const leaving = records.filter((record) => record.pluginId === pluginId);
      if (leaving.length === 0) continue;
      const kept = records.filter((record) => record.pluginId !== pluginId);
      if (kept.length === 0) this.verified.delete(id);
      else this.verified.set(id, kept);
      for (const record of leaving) this.notifyCapabilityWatchers(id, record.implementation, "withdraw");
    }
  }

  /**
   * @implNote A watcher that throws is reported and the rest still hear, as for a service watcher;
   * a watcher removed while the others are being told is skipped rather than called.
   */
  private notifyCapabilityWatchers(id: string, implementation: unknown, event: CapabilityEvent): void {
    const installed = this.capabilityWatchers.get(id);
    if (installed === undefined) return;
    for (const watcher of [...installed]) {
      if (!installed.has(watcher)) continue;
      try {
        watcher.listener(implementation, event);
      } catch (failure) {
        this.diagnostics(`a watcher of capability "${id}" threw while handling ${event}: ${String(failure)}`);
      }
    }
  }

  /** Refuses a capability the plugin did not declare, reporting it once per plugin and id (invariant 14). */
  private refuseUndeclaredCapability(pluginId: string, capabilityId: string): void {
    const fix = `add "${capabilityId}" to capabilities.consumes in its plugin.json`;
    if (this.ledger.recordCapabilityRefused(pluginId, capabilityId)) {
      this.diagnostics(`refused capability "${capabilityId}" to ${pluginId}, which does not declare it: ${fix}`);
    }
  }

  /**
   * @implNote A late `get` is let through, because it installs nothing and a stopped plugin still
   * polling would otherwise flood the sink. The declaration is checked before lateness, so an
   * undeclared call is refused as undeclared whether or not it is late. `reaches` ignores the late
   * state on purpose, so a revoked plugin's `ids()` still lists what it declared, as a late `get`
   * is let through.
   */
  private fenceFor(pluginId: string, declared: ReadonlySet<string>, bound: ReadonlyMap<string, string>): Fence {
    const lateRefusal = (attempt: ServiceAttempt, id: string): PluginError | null => {
      if (attempt === "get" || !this.refuseLate(pluginId, `a late ${attempt} of service`, id)) return null;
      return stoppedWaiting(pluginId, id);
    };
    return {
      refusal: (attempt, id) => {
        if (attempt !== "registration" && !declared.has(id)) return this.refuseUndeclared(pluginId, id);
        const mismatch = attempt === "registration" ? null : this.refuseOwnedElsewhere(pluginId, id, bound.get(id));
        return mismatch ?? lateRefusal(attempt, id);
      },
      reaches: (id) => declared.has(id),
    };
  }

  /** Refuses a service the plugin did not declare, reporting it once per plugin and id (invariant 12). */
  private refuseUndeclared(pluginId: string, serviceId: string): PluginError {
    const refusal = pluginError(
      pluginId,
      `reached for service "${serviceId}", which it does not declare`,
      `add "${serviceId}" to services.consumes in its plugin.json`,
    );
    if (this.ledger.recordServiceRefused(pluginId, serviceId)) {
      this.diagnostics(`refused service "${serviceId}" to ${pluginId}, which does not declare it: ${refusal.fix}`);
    }
    return refusal;
  }

  /**
   * Refuses a service owned by someone other than the provider the consumer is bound to, reporting
   * it once per plugin and id.
   *
   * @implNote A bound service nobody provides is absence, never a mismatch, exactly as for an
   * unbound consumer.
   */
  private refuseOwnedElsewhere(pluginId: string, serviceId: string, provider: string | undefined): PluginError | null {
    const owner = this.hub.ownerOf(serviceId);
    if (provider === undefined || owner === undefined || owner === provider) return null;
    return this.refuseWrongProvider(pluginId, serviceId, provider, owner);
  }

  private refuseWrongProvider(pluginId: string, serviceId: string, provider: string, owner: string): PluginError {
    const refusal = pluginError(
      pluginId,
      `reached for service "${serviceId}", which it binds to ${provider} but ${owner} provides`,
      `install ${provider}, or remove "provider" from "${serviceId}" in services.consumes of its plugin.json`,
    );
    if (this.ledger.recordServiceRefused(pluginId, serviceId)) {
      this.diagnostics(`refused service "${serviceId}" to ${pluginId}, which binds it to ${provider} while ${owner} provides it: ${refusal.fix}`);
    }
    return refusal;
  }

  /**
   * Whether a call from this plugin arrives after it was quarantined or released.
   *
   * @implNote Quarantine stops the host waiting for a plugin, not the plugin: an activation
   * abandoned at its deadline can still finish. A late call is reported rather than thrown, because
   * its caller is work nobody is waiting on.
   */
  private refuseLate(pluginId: string, what: string, id: string): boolean {
    if (!this.revoked.has(pluginId)) return false;
    this.diagnostics(`ignored ${what} "${id}" from ${pluginId}, which is no longer running`);
    return true;
  }

  private recording(pluginId: string, bus: RuntimeEvents): RuntimeEvents {
    return {
      publish: (topic, payload) => bus.publish(topic, payload),
      subscribe: (topic, listener) => {
        if (this.refuseLate(pluginId, "a late subscription to topic", topic)) return () => {};
        this.ledger.recordTopic(pluginId, topic);
        return this.tracked(pluginId, bus.subscribe(topic, listener));
      },
    };
  }

  private tracked(pluginId: string, dispose: () => void): () => void {
    const owned = this.disposers.get(pluginId) ?? new Set<() => void>();
    this.disposers.set(pluginId, owned);
    let done = false;
    const once = (): void => {
      if (done) return;
      done = true;
      dispose();
      owned.delete(once);
      if (owned.size === 0 && this.disposers.get(pluginId) === owned) this.disposers.delete(pluginId);
    };
    owned.add(once);
    return once;
  }
}

/** One installed capability listener, an identity of its own so the same listener can be installed twice. */
interface CapabilityWatcher {
  readonly listener: CapabilityListener;
}

/** The capability ids a plugin may reach: what it consumes and what it provides itself. */
function declaredCapabilities(facts: ManifestFacts): ReadonlySet<string> {
  return new Set([...facts.capabilitiesConsumed, ...facts.capabilitiesProvided]);
}

/**
 * The service ids a plugin may reach: what it consumes and what it provides itself.
 *
 * @implNote Read defensively, because `contextFor` is handed manifests nobody validated, and one
 * whose services are malformed reaches nothing rather than taking the host down.
 */
function declaredServices(manifest: PluginManifest): ReadonlySet<string> {
  const consumed = listOf(manifest.services?.consumes).map((declaration) => readRequirement(declaration).id);
  const provided = listOf(manifest.services?.provides).map((declaration) => readOffer(declaration).id);
  return new Set([...consumed, ...provided].filter((id): id is string => typeof id === "string"));
}

function listOf<T>(declarations: readonly T[] | undefined): readonly T[] {
  return Array.isArray(declarations) ? declarations.filter((declaration) => declaration !== null && declaration !== undefined) : [];
}

function importNameOf(manifest: PluginManifest, pluginId: string): string {
  return typeof manifest.importName === "string" && manifest.importName !== "" ? manifest.importName : pluginId;
}

/** The provider each bound consumed service is pinned to, read defensively like `declaredServices`. */
function boundProviders(manifest: PluginManifest): ReadonlyMap<string, string> {
  const bound = new Map<string, string>();
  for (const declaration of listOf(manifest.services?.consumes)) {
    const { id, provider } = readRequirement(declaration);
    if (typeof id === "string" && provider !== undefined) bound.set(id, provider);
  }
  return bound;
}
