import { join } from "node:path";
import { afterEach } from "vitest";
import { createCore, sharedLibraryFileName, Status, type Core, type CoreEvent, type CreateCoreOptions } from "../src/core/index.ts";

export const coreLibraryPath = join(import.meta.dirname, "..", "native", sharedLibraryFileName("weivel_core"));

const createdCores: Core[] = [];

afterEach(() => {
  for (const core of createdCores.splice(0)) {
    core.destroy();
  }
});

export interface RecordedCore {
  readonly core: Core;
  readonly dispatched: CoreEvent[];
}

/** A core built in native/, every event it dispatches recorded, destroyed after the test. */
export function createRecordedCore(options: Omit<CreateCoreOptions, "libraryPath" | "dispatcher"> = {}): RecordedCore {
  const dispatched: CoreEvent[] = [];
  const created = createCore({ ...options, libraryPath: coreLibraryPath, dispatcher: (event) => dispatched.push(event) });
  if (created.status !== Status.Ok || created.value === undefined) {
    throw new Error(`weivel_core_create answered ${created.status}`);
  }
  createdCores.push(created.value);
  return { core: created.value, dispatched };
}

/** Registers and opens a plugin, failing the test when the core refuses either. */
export function openPlugin(core: Core, manifest: Parameters<Core["registerManifest"]>[0]): bigint {
  const registered = core.registerManifest(manifest);
  if (registered.status !== Status.Ok || registered.value === undefined) {
    throw new Error(`weivel_register_manifest answered ${registered.status} for ${manifest.importName}`);
  }
  const opened = core.openPlugin(registered.value);
  if (opened.status !== Status.Ok) {
    throw new Error(`weivel_open_plugin answered ${opened.status} for ${manifest.importName}`);
  }
  return registered.value;
}
