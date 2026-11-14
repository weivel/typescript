import type { CoreEvent, CoreOptions, Manifest } from "../../src/core/index.ts";
import { PluginContexts, type Logger, type PluginContext } from "../../src/context/index.ts";
import { createRecordedCore, openPlugin } from "../real-core.ts";

export interface LogEntry {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly cause?: unknown;
}

export interface RecordingLogger {
  readonly logger: Logger;
  readonly entries: LogEntry[];
}

export function recordingLogger(): RecordingLogger {
  const entries: LogEntry[] = [];
  return {
    entries,
    logger: {
      debug: (message) => entries.push({ level: "debug", message }),
      info: (message) => entries.push({ level: "info", message }),
      warn: (message) => entries.push({ level: "warn", message }),
      error: (message, cause) => entries.push({ level: "error", message, cause }),
    },
  };
}

/** A clock the test moves by hand. */
export class ManualClock {
  time = 0;
  now(): number {
    return this.time;
  }
}

export interface OpenedPlugin {
  readonly plugin: bigint;
  readonly context: PluginContext;
  readonly log: RecordingLogger;
}

/** A real core whose every event reaches the contexts, plugins opened in it with a context each. */
export function createWorld(options: CoreOptions = {}) {
  const sunk: { readonly error: unknown; readonly event: CoreEvent | undefined }[] = [];
  const { core, dispatched } = createRecordedCore({ options, onListenerError: (error, event) => sunk.push({ error, event }) });
  const clock = new ManualClock();
  const hostLog = recordingLogger();
  const contexts = new PluginContexts(core, { clock, log: hostLog.logger });
  core.setDispatcher((event) => {
    dispatched.push(event);
    contexts.receive(event);
  });
  const open = (manifest: Manifest): OpenedPlugin => {
    const plugin = openPlugin(core, manifest);
    const log = recordingLogger();
    return { plugin, log, context: contexts.create(plugin, manifest, log.logger) };
  };
  return { core, dispatched, contexts, clock, hostLog, open, sunk };
}

/** Lets every settled promise's callbacks run. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
