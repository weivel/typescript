import { API_VERSION } from "../index.js";
import type { HostDescriptor, PluginContext, PluginError, PluginManifest, Scheduler } from "../index.js";
import { compatibility } from "./compatibility.js";
import type { ConstraintEntry } from "./constraints.js";
import { contextOf } from "./context.js";
import type { PluginRuntime, RuntimeEvents } from "./context.js";
import { DISCARD } from "./diagnostics.js";
import type { DiagnosticSink } from "./diagnostics.js";
import { pluginError } from "./errors.js";
import { factsOf } from "./facts.js";
import type { Handles } from "./handles.js";
import { PluginLedger } from "./ledger.js";
import type { LedgerRow, ServiceRefusal } from "./ledger.js";
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
  /** Every service a plugin reached for without declaring it, once per plugin and id, in the order reported. */
  refusals(): ServiceRefusal[];
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
  /** Every implementation of a capability, in activation order. */
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
  private readonly disposers = new Map<string, Set<() => void>>();
  private readonly revoked = new Set<string>();

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
        recordDeclared: (manifest) => this.recordDeclared(manifest),
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

  private recordDeclared(manifest: PluginManifest): string {
    const facts = factsOf(manifest);
    this.ledger.recordDeclared(facts.id, facts.capabilities, facts.permissions);
    return facts.id;
  }

  private contextFor(manifest: PluginManifest, runtime: PluginRuntime): PluginContext {
    const pluginId = this.recordDeclared(manifest);
    this.revoked.delete(pluginId);
    return contextOf({
      manifest,
      host: this.descriptor,
      runtime,
      registry: this.hub.forConsumer(pluginId, this.fenceFor(pluginId, declaredServices(manifest))),
      events: this.recording(pluginId, runtime.events),
      provide: (capabilityId, implementation) => this.provide(pluginId, capabilityId, implementation),
    });
  }

  private verifyActivation(manifest: PluginManifest): PluginError | null {
    const { id, capabilities: declared } = factsOf(manifest);
    const provided = this.ledger.entry(id)?.capabilitiesProvided ?? [];
    const missing = declared.filter((capability) => !provided.includes(capability));
    if (missing.length > 0) {
      return pluginError(
        id,
        `capabilities declared but never provided: ${missing.join(", ")}`,
        `call context.provide(context.capability("${missing[0]}"), ...) in activate, or remove it from "capabilities" in plugin.json`,
      );
    }
    const extra = provided.filter((capability) => !declared.includes(capability));
    if (extra.length > 0) {
      return pluginError(id, `capabilities provided but never declared: ${extra.join(", ")}`, `add "${extra[0]}" to "capabilities" in plugin.json`);
    }
    this.ledger.recordStatus(id, "active");
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
   * @implNote A late `get` is let through, because it installs nothing and a stopped plugin still
   * polling would otherwise flood the sink; an undeclared one is refused whether or not it is late.
   */
  private fenceFor(pluginId: string, declared: ReadonlySet<string>): Fence {
    const lateRefusal = (attempt: ServiceAttempt, id: string): PluginError | null => {
      if (attempt === "get" || !this.refuseLate(pluginId, `a late ${attempt} of service`, id)) return null;
      return stoppedWaiting(pluginId, id);
    };
    return {
      refusal: (attempt, id) => {
        const late = lateRefusal(attempt, id);
        if (late !== null || attempt === "registration" || declared.has(id)) return late;
        return this.refuseUndeclared(pluginId, id);
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
