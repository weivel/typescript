export type PluginStatus = "activating" | "active" | "broken" | "stopped";

/** Why a broken plugin's row says it is broken. */
export interface LedgerError {
  detail: string;
  fix: string;
}

/** One plugin's row: every relationship that passed through its context. */
export interface LedgerRow {
  capabilitiesDeclared: string[];
  capabilitiesProvided: string[];
  error?: LedgerError;
  permissions: string[];
  pluginId: string;
  /** Service ids it asked for, answered or not. */
  servicesConsumed: string[];
  servicesProvided: string[];
  status: PluginStatus;
  /** Event topics it subscribed to. */
  topics: string[];
}

/** One plugin refused a service it did not declare. */
export interface ServiceRefusal {
  pluginId: string;
  serviceId: string;
}

interface Relationships {
  capabilitiesDeclared: Set<string>;
  capabilitiesProvided: Set<string>;
  permissions: Set<string>;
  servicesConsumed: Set<string>;
  servicesProvided: Set<string>;
  topics: Set<string>;
}

class Entry {
  relationships: Relationships = fresh();
  status: PluginStatus = "activating";
  error: LedgerError | undefined;

  constructor(readonly pluginId: string) {}

  row(): LedgerRow {
    const { relationships } = this;
    const row: LedgerRow = {
      pluginId: this.pluginId,
      status: this.status,
      capabilitiesDeclared: [...relationships.capabilitiesDeclared],
      capabilitiesProvided: [...relationships.capabilitiesProvided],
      servicesProvided: [...relationships.servicesProvided],
      servicesConsumed: [...relationships.servicesConsumed],
      topics: [...relationships.topics],
      permissions: [...relationships.permissions],
    };
    if (this.error !== undefined) row.error = { ...this.error };
    return row;
  }
}

function fresh(): Relationships {
  return {
    capabilitiesDeclared: new Set(),
    capabilitiesProvided: new Set(),
    permissions: new Set(),
    servicesConsumed: new Set(),
    servicesProvided: new Set(),
    topics: new Set(),
  };
}

/**
 * The record of every relationship that passed through a plugin context.
 *
 * @remarks
 * Kept as it happens rather than assembled on demand, because a relationship is only observable at
 * the moment it is made. A developer section, a doctor and a quarantine view all render this.
 */
export class PluginLedger {
  private readonly rows = new Map<string, Entry>();
  private readonly refused: ServiceRefusal[] = [];

  /** Every row, as copies a caller may keep. */
  entries(): LedgerRow[] {
    return [...this.rows.values()].map((entry) => entry.row());
  }

  entry(pluginId: string): LedgerRow | undefined {
    return this.rows.get(pluginId)?.row();
  }

  /**
   * Opens a row at `activating`.
   *
   * @implNote Resets every relationship: a row describes ONE activation, so a plugin that stops and
   * activates again is described by what it does this time, not by the union of every cycle.
   */
  recordDeclared(pluginId: string, capabilities: readonly string[], permissions: readonly string[]): void {
    const entry = this.ensure(pluginId);
    entry.relationships = fresh();
    entry.status = "activating";
    entry.error = undefined;
    for (const id of capabilities) entry.relationships.capabilitiesDeclared.add(id);
    for (const permission of permissions) entry.relationships.permissions.add(permission);
  }

  recordCapabilityProvided(pluginId: string, capabilityId: string): void {
    this.ensure(pluginId).relationships.capabilitiesProvided.add(capabilityId);
  }

  recordServiceProvided(pluginId: string, serviceId: string): void {
    this.ensure(pluginId).relationships.servicesProvided.add(serviceId);
  }

  recordServiceConsumed(pluginId: string, serviceId: string): void {
    this.ensure(pluginId).relationships.servicesConsumed.add(serviceId);
  }

  recordTopic(pluginId: string, topic: string): void {
    this.ensure(pluginId).relationships.topics.add(topic);
  }

  /**
   * Records that a plugin was refused a service, and answers whether this is the first time.
   *
   * @implNote Kept across activations rather than reset with a row, because the record exists to
   * report a refusal once per plugin and id, and a plugin polling an id it never declared would
   * otherwise be reported again every time it restarts.
   */
  recordServiceRefused(pluginId: string, serviceId: string): boolean {
    if (this.refused.some((entry) => entry.pluginId === pluginId && entry.serviceId === serviceId)) return false;
    this.refused.push({ pluginId, serviceId });
    return true;
  }

  /** Every refusal, in the order first reported, as copies a caller may keep. */
  refusals(): ServiceRefusal[] {
    return this.refused.map((entry) => ({ ...entry }));
  }

  /** Moves a plugin to a status, with the error that put it there, or none to clear it. */
  recordStatus(pluginId: string, status: PluginStatus, error?: LedgerError): void {
    const entry = this.ensure(pluginId);
    entry.status = status;
    entry.error = error === undefined ? undefined : { detail: error.detail, fix: error.fix };
  }

  private ensure(pluginId: string): Entry {
    const existing = this.rows.get(pluginId);
    if (existing !== undefined) return existing;
    const created = new Entry(pluginId);
    this.rows.set(pluginId, created);
    return created;
  }
}
