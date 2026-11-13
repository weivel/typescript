import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EdgeSource, type CoreOptions, type Manifest } from "../core/index.js";
import type { Logger, PluginContext } from "../context/index.js";
import { Host } from "../host/index.js";
import type { Clock, Scheduler } from "../timer/index.js";

/** Where the driver finds the core and the standard; `native/` beside the package by default, as for the host. */
export interface DriverOptions {
  readonly coreLibraryPath?: string;
  readonly standardLibraryPath?: string;
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
      due[1].callback();
      await settled();
    }
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

/** A plugin's manifest as the standard reads it from disk, written by the driver. */
export type WrittenManifest = Record<string, unknown> & { readonly importName: string };

/** A host on virtual time over plugins the driver wrote into a directory of its own, every log recorded. */
export class DriverWorld {
  readonly host: Host;
  readonly time = new VirtualTime();
  readonly logs: DriverLogEntry[] = [];
  readonly #directory = mkdtempSync(join(tmpdir(), "weivel-conformance-"));
  readonly #plugins = new Map<string, bigint>();

  constructor(options: DriverOptions, core: CoreOptions = {}) {
    try {
      this.host = Host.create({
        edgeSource: EdgeSource.Capabilities,
        ...(options.coreLibraryPath === undefined ? {} : { coreLibraryPath: options.coreLibraryPath }),
        ...(options.standardLibraryPath === undefined ? {} : { standardLibraryPath: options.standardLibraryPath }),
        core,
        clock: this.time,
        scheduler: this.time,
        log: recordingLogger("host", this.logs),
        pluginLog: (manifest: Manifest) => recordingLogger(manifest.importName, this.logs),
      });
    } catch (error) {
      rmSync(this.#directory, { recursive: true, force: true });
      throw error;
    }
  }

  /** Writes each manifest, has the host discover them, and fails unless the host registered every one. */
  discover(manifests: readonly WrittenManifest[]): void {
    for (const manifest of manifests) {
      writeFileSync(join(this.#directory, `${manifest.importName}.json`), JSON.stringify({ api: 1, ...manifest }));
    }
    const report = this.host.discover(this.#directory);
    for (const hosted of report.registered) {
      this.#plugins.set(hosted.manifest.importName, hosted.plugin);
    }
    const missing = manifests.filter((manifest) => !this.#plugins.has(manifest.importName));
    if (missing.length > 0) {
      throw new Error(`The host did not register ${missing.map((manifest) => manifest.importName).join(", ")}.`);
    }
  }

  plugin(importName: string): bigint {
    const plugin = this.#plugins.get(importName);
    if (plugin === undefined) {
      throw new Error(`The vector names a plugin it does not give: ${importName}.`);
    }
    return plugin;
  }

  open(importName: string): PluginContext {
    return this.host.open(this.plugin(importName));
  }

  close(options: DriverOptions): void {
    try {
      options.inspect?.(this.host);
    } finally {
      this.host.destroy();
      rmSync(this.#directory, { recursive: true, force: true });
    }
  }
}
