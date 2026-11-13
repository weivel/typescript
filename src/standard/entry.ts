import { pathToFileURL } from "node:url";
import type { Manifest } from "../core/values.js";
import { ActivationFailure, messageOf } from "../host/activation-failure.js";
import type { Plugin } from "../host/model.js";
import type { DiscoveredPlugin } from "./answers.js";
import { identifiedManifest } from "./standard.js";

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
 *
 * @throws ActivationFailure saying why the entry cannot be activated.
 */
async function importPlugin(entryPath: string | null, entryPresent: boolean): Promise<Plugin> {
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

/**
 * The entry of a plugin laid out on disk: its activate imports the module the standard resolved and calls that
 * module's activate; its deactivate calls the module's, once one was imported.
 */
export function entryOnDisk(entryPath: string | null, entryPresent: boolean): Plugin {
  let imported: Plugin | undefined;
  return {
    async activate(context) {
      imported = await importPlugin(entryPath, entryPresent);
      await imported.activate(context);
    },
    deactivate() {
      return imported?.deactivate?.();
    },
  };
}

/** What the host registers for a plugin the standard discovered: its manifest, and an entry. */
export interface PluginRegistration {
  readonly manifest: Manifest;
  readonly entry: Plugin;
}

/**
 * The manifest and entry a discovered plugin is registered with: the standard's manifest carrying the identity file's
 * id when there is one, and the entry on disk.
 */
export function registrationOf(discovered: DiscoveredPlugin): PluginRegistration {
  return { manifest: identifiedManifest(discovered), entry: entryOnDisk(discovered.entryPath, discovered.entryPresent) };
}
