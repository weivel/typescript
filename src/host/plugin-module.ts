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

let loadCount = 0;

/**
 * A URL no earlier load used, so a plugin loaded again runs its entry as the file now is.
 *
 * @implNote ESM caches a module by URL for the life of the process. Each load gets a URL of its own, and Node still
 * keeps every earlier module object in memory: a runtime limit no ESM code can lift.
 */
function uniqueUrlOf(entryPath: string): string {
  loadCount += 1;
  return `${pathToFileURL(entryPath).href}?load=${loadCount}`;
}

/**
 * Imports the entry the standard resolved for a plugin and answers its default export. An entry the standard did not
 * find present, a regular file reached through no link, is never imported.
 */
export async function importPlugin(entryPath: string | null, entryPresent: boolean): Promise<Plugin> {
  if (entryPath === null) {
    throw new ActivationFailure("its manifest names no entry", 'name the plugin\'s entry module in its manifest\'s "entry"');
  }
  if (!entryPresent) {
    throw new ActivationFailure(
      `its entry ${entryPath} is not a regular file reached through no link`,
      "lay the entry out as a regular file inside the plugin's directory, with no link on its path",
    );
  }
  let entry: { default?: unknown };
  try {
    entry = (await import(uniqueUrlOf(entryPath))) as { default?: unknown };
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
