import { EdgeSource, type CoreOptions, type Manifest } from "../core/index.js";
import type { Logger, PluginContext } from "../context/index.js";
import { Host, isHostDestroyed, type HostDestroyed, type Plugin } from "../host/index.js";
import type { Clock, Scheduler } from "../timer/index.js";

/** Where the driver finds the core; `native/` beside the package by default, as for the host. */
export interface DriverOptions {
  readonly coreLibraryPath?: string;
  /** Sees the host after the last step, before the driver destroys it. */
  readonly inspect?: (host: Host) => void;
}

export interface DriverLogEntry {
  /** The plugin whose log it was written on, or `host`. */
  readonly source: string;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly cause?: unknown;
}

interface ScheduledTask {
  readonly callback: () => void;
  readonly dueAt: number;
}

/** Virtual time the driver moves: a clock and a scheduler whose tasks run only when the driver runs time forward. */
export class VirtualTime implements Clock, Scheduler {
  #now = 0;
  #nextToken = 0;
  readonly #tasks = new Map<number, ScheduledTask>();
  /** The time each task ran at, in the order they ran: what the layer's timer did, not what it said it did. */
  readonly fired: number[] = [];

  now(): number {
    return this.#now;
  }

  schedule(callback: () => void, delayMilliseconds: number): unknown {
    this.#nextToken += 1;
    this.#tasks.set(this.#nextToken, { callback, dueAt: this.#now + delayMilliseconds });
    return this.#nextToken;
  }

  cancel(token: unknown): void {
    this.#tasks.delete(token as number);
  }

  /** Runs every task due by `time` in the order they fall due, each at its own time, then stands at `time`. */
  async runUntil(time: number): Promise<void> {
    for (let due = this.#earliestDue(time); due !== undefined; due = this.#earliestDue(time)) {
      this.#tasks.delete(due[0]);
      this.#now = Math.max(this.#now, due[1].dueAt);
      this.fired.push(this.#now);
      due[1].callback();
      await settled();
    }
    this.#now = Math.max(this.#now, time);
  }

  /** Moves the clock to `time` and runs no task, as a scheduler that has not yet taken its turn. */
  moveClockTo(time: number): void {
    this.#now = Math.max(this.#now, time);
  }

  #earliestDue(time: number): [number, ScheduledTask] | undefined {
    let earliest: [number, ScheduledTask] | undefined;
    for (const entry of this.#tasks) {
      if (entry[1].dueAt <= time && (earliest === undefined || entry[1].dueAt < earliest[1].dueAt)) {
        earliest = entry;
      }
    }
    return earliest;
  }
}

/** Lets every settled promise's callbacks run. */
export function settled(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function recordingLogger(source: string, entries: DriverLogEntry[]): Logger {
  return {
    debug: (message) => entries.push({ source, level: "debug", message }),
    info: (message) => entries.push({ source, level: "info", message }),
    warn: (message) => entries.push({ source, level: "warn", message }),
    error: (message, cause) => entries.push({ source, level: "error", message, cause }),
  };
}

/** A plugin the driver builds from a vector: its manifest value and the entry the host is handed. */
export interface BuiltPlugin {
  readonly manifest: Manifest;
  readonly entry: Plugin;
}

/** An entry for a plugin the driver opens itself and never activates. */
export const inertEntry: Plugin = { activate() {} };

/** The answer of a host call the driver makes only while the host lives. */
export function alive<Answer>(answer: Answer | HostDestroyed): Answer {
  if (isHostDestroyed(answer)) {
    throw new Error("The driver called a host it had destroyed.");
  }
  return answer;
}

/** A host on virtual time over plugins the driver builds as values, every log recorded. */
export class DriverWorld {
  readonly host: Host;
  readonly time = new VirtualTime();
  readonly logs: DriverLogEntry[] = [];
  /** What reached the host's error sink. */
  readonly sunk: unknown[] = [];
  /** Each move the host's timer made, as `[the time it moved, the deadline it armed or null]`. */
  readonly timerMoves: [number, number | null][] = [];
  readonly #plugins = new Map<string, bigint>();

  constructor(options: DriverOptions, core: CoreOptions = {}, edgeSource: EdgeSource = EdgeSource.Capabilities) {
    this.host = Host.create({
      edgeSource,
      ...(options.coreLibraryPath === undefined ? {} : { coreLibraryPath: options.coreLibraryPath }),
      core,
      clock: this.time,
      scheduler: this.time,
      log: recordingLogger("host", this.logs),
      pluginLog: (manifest: Manifest) => recordingLogger(manifest.importName, this.logs),
      onListenerError: (error) => void this.sunk.push(error),
      onTimerMove: (deadline) => void this.timerMoves.push([this.time.now(), deadline ?? null]),
    });
  }

  /** Registers each plugin through the host, and fails unless the core registered every one. */
  register(plugins: readonly BuiltPlugin[]): void {
    for (const { manifest, entry } of plugins) {
      const answer = alive(this.host.register(manifest, entry));
      if (answer.plugin === undefined) {
        throw new Error(`The host did not register ${manifest.importName}: ${answer.refusal.detail ?? `code ${answer.refusal.code}`}.`);
      }
      this.#plugins.set(manifest.importName, answer.plugin);
    }
  }

  /** Every import name the driver registered, with its handle. */
  registered(): ReadonlyMap<string, bigint> {
    return this.#plugins;
  }

  plugin(importName: string): bigint {
    const plugin = this.#plugins.get(importName);
    if (plugin === undefined) {
      throw new Error(`The vector names a plugin it does not give: ${importName}.`);
    }
    return plugin;
  }

  open(importName: string): PluginContext {
    return alive(this.host.open(this.plugin(importName)));
  }

  async close(options: DriverOptions): Promise<void> {
    try {
      options.inspect?.(this.host);
    } finally {
      await this.host.destroy();
    }
  }
}
