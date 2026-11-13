import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { EdgeSource, sharedLibraryFileName, type CoreOptions } from "../../src/core/index.ts";
import type { PluginContext } from "../../src/context/index.ts";
import { Host, type HostOptions } from "../../src/host/index.ts";
import type { Scheduler } from "../../src/timer/index.ts";
import { ManualClock, recordingLogger, type RecordingLogger } from "../context/world.ts";
import { coreLibraryPath } from "../real-core.ts";
import { standardLibraryPath } from "../real-standard.ts";

export const echoLibraryPath = join(import.meta.dirname, "..", "..", "native", "test", sharedLibraryFileName("echo"));

/** What the generated plugins tell the test: who activated and deactivated, in order, and each one's context. */
export interface Probe {
  readonly activated: string[];
  readonly deactivated: string[];
  readonly contexts: Map<string, PluginContext>;
}

declare global {
  var weivelHostProbe: Probe;
}

beforeEach(() => {
  globalThis.weivelHostProbe = { activated: [], deactivated: [], contexts: new Map() };
});

const temporaryDirectories: string[] = [];
const createdHosts: Host[] = [];

afterEach(async () => {
  for (const host of createdHosts.splice(0)) {
    await host.destroy();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A plugin the test writes: its manifest, and, when it has an entry, the module's source under the entry's name. */
export interface WrittenPlugin {
  readonly manifest: Record<string, unknown> & { readonly importName: string };
  readonly entrySource?: string;
  readonly identity?: { readonly id: string; readonly name: string };
}

export type EntryLanguage = "ts" | "js";

/**
 * The source of an entry module whose activate records itself in the probe and then runs `body`, which sees
 * `context` and `probe`.
 */
export function entrySource(importName: string, body = "", language: EntryLanguage = "js"): string {
  const contextType = language === "ts" ? ": { readonly manifest: unknown }" : "";
  return [
    "const probe = globalThis.weivelHostProbe;",
    "export default {",
    `  async activate(context${contextType}) {`,
    `    probe.activated.push(${JSON.stringify(importName)});`,
    `    probe.contexts.set(${JSON.stringify(importName)}, context);`,
    `    ${body}`,
    "  },",
    `  deactivate() { probe.deactivated.push(${JSON.stringify(importName)}); },`,
    "};",
    "",
  ].join("\n");
}

/** A plugin whose entry, `<importName>.<language>`, activates by running `body`. */
export function plugin(manifest: WrittenPlugin["manifest"], body = "", language: EntryLanguage = "js"): WrittenPlugin {
  return {
    manifest: { entry: `${manifest.importName}.${language}`, ...manifest },
    entrySource: entrySource(manifest.importName, body, language),
  };
}

/** A fresh directory laid out as the standard discovers it, every manifest at api 1 unless it says, removed after the test. */
export function pluginDirectory(plugins: readonly WrittenPlugin[]): string {
  const directory = mkdtempSync(join(tmpdir(), "weivel-host-"));
  temporaryDirectories.push(directory);
  for (const written of plugins) {
    const name = written.manifest.importName;
    writeFileSync(join(directory, `${name}.json`), JSON.stringify({ api: 1, ...written.manifest }));
    if (written.entrySource !== undefined && typeof written.manifest.entry === "string") {
      writeFileSync(join(directory, written.manifest.entry), written.entrySource);
    }
    if (written.identity !== undefined) {
      writeFileSync(join(directory, `${name}_identity.json`), JSON.stringify(written.identity));
    }
  }
  return directory;
}

/**
 * Makes `link` a link to the directory `target`.
 *
 * @remarks A junction on Windows, which needs no privilege there, unlike a symbolic link; a symbolic link elsewhere.
 */
export function linkDirectory(target: string, link: string): void {
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

/** Every file of a directory and its text, to compare the directory before and after the host ran. */
export function directoryContents(directory: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(directory)
      .sort()
      .map((name) => [name, readFileSync(join(directory, name), "utf8")]),
  );
}

/** A scheduler the test fires by hand. */
export class ManualScheduler implements Scheduler {
  readonly armed = new Map<number, { readonly callback: () => void; readonly delayMilliseconds: number }>();
  #next = 0;

  schedule(callback: () => void, delayMilliseconds: number): unknown {
    this.#next += 1;
    this.armed.set(this.#next, { callback, delayMilliseconds });
    return this.#next;
  }

  cancel(token: unknown): void {
    this.armed.delete(token as number);
  }

  fire(): void {
    const armed = [...this.armed.entries()];
    this.armed.clear();
    for (const [, task] of armed) {
      task.callback();
    }
  }
}

export interface HostWorld {
  readonly host: Host;
  readonly clock: ManualClock;
  readonly scheduler: ManualScheduler;
  readonly hostLog: RecordingLogger;
  readonly pluginLogs: Map<string, RecordingLogger>;
}

/** A host on the real core and standard in native/, a hand-moved clock and scheduler, every log recorded. */
export function createHostWorld(core: CoreOptions = {}, options: Partial<HostOptions> = {}): HostWorld {
  const clock = new ManualClock();
  const scheduler = new ManualScheduler();
  const hostLog = recordingLogger();
  const pluginLogs = new Map<string, RecordingLogger>();
  const host = Host.create({
    edgeSource: EdgeSource.Capabilities,
    coreLibraryPath,
    standardLibraryPath,
    core,
    clock,
    scheduler,
    log: hostLog.logger,
    pluginLog: (manifest) => {
      const log = recordingLogger();
      pluginLogs.set(manifest.importName, log);
      return log.logger;
    },
    ...options,
  });
  createdHosts.push(host);
  return { host, clock, scheduler, hostLog, pluginLogs };
}

/** Lets every settled promise's callbacks run. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
