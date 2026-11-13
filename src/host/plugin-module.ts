import { pathToFileURL } from "node:url";
import type { QuarantineReason } from "../core/index.js";
import type { Plugin } from "./model.js";

/** Why a plugin could not be activated, as the reason its quarantine carries. */
export class ActivationFailure extends Error {
  readonly reason: QuarantineReason;

  constructor(detail: string, fix: string) {
    super(detail);
    this.name = "ActivationFailure";
    this.reason = { detail, fix };
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlugin(value: unknown): value is Plugin {
  return typeof value === "object" && value !== null && typeof (value as Partial<Plugin>).activate === "function";
}

/** Imports the entry the standard resolved for a plugin and answers its default export. */
export async function importPlugin(entryPath: string | null): Promise<Plugin> {
  if (entryPath === null) {
    throw new ActivationFailure("its manifest names no entry", 'name the plugin\'s entry module in its manifest\'s "entry"');
  }
  let entry: { default?: unknown };
  try {
    entry = (await import(pathToFileURL(entryPath).href)) as { default?: unknown };
  } catch (error) {
    throw new ActivationFailure(`its entry ${entryPath} could not be loaded: ${messageOf(error)}`, "make the entry a module that loads");
  }
  if (!isPlugin(entry.default)) {
    throw new ActivationFailure(
      `its entry ${entryPath} has no default export with an activate function`,
      "export default an object whose activate(context) activates the plugin",
    );
  }
  return entry.default;
}

export function activateThrew(error: unknown): ActivationFailure {
  return new ActivationFailure(`its activate threw: ${messageOf(error)}`, "make the plugin's activate return without throwing");
}
