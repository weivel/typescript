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
 * Imports the entry the standard resolved for a plugin and answers its export named `exportName`. An entry the
 * standard did not find present, a regular file reached through no link, is never imported.
 *
 * @throws ActivationFailure saying why the entry cannot be activated.
 */
async function importPlugin(entryPath: string | null, entryPresent: boolean, exportName: string): Promise<Plugin> {
  if (entryPath === null) {
    throw new ActivationFailure("its manifest names no entry", 'name the plugin\'s entry module in its manifest\'s "entry"');
  }
  if (!entryPresent) {
    throw new ActivationFailure(
      `its entry ${entryPath} is not a regular file reached through no link`,
      "lay the entry out as a regular file inside the plugin's directory, with no link on its path",
    );
  }
  let entry: Record<string, unknown>;
  try {
    entry = (await import(uniqueUrlOf(entryPath))) as Record<string, unknown>;
  } catch (error) {
    throw new ActivationFailure(`its entry ${entryPath} could not be loaded: ${messageOf(error)}`, "make the entry a module that loads");
  }
  const exported = Object.hasOwn(entry, exportName) ? entry[exportName] : undefined;
  if (!isPlugin(exported)) {
    throw new ActivationFailure(
      `its entry ${entryPath} has no export ${JSON.stringify(exportName)} with an activate function`,
      `export ${JSON.stringify(exportName)} as an object whose activate(context) activates the plugin`,
    );
  }
  return exported;
}

/**
 * The entry of a plugin laid out on disk: its activate imports the module the standard resolved and calls the
 * activate of the export its caller names; its deactivate calls that export's, once one was imported. No export name
 * is assumed, `default` included.
 */
export function entryOnDisk(entryPath: string | null, entryPresent: boolean, exportName: string): Plugin {
  let imported: Plugin | undefined;
  return {
    async activate(context) {
      imported = await importPlugin(entryPath, entryPresent, exportName);
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
 * id when there is one, and the entry on disk, loaded by the export its caller names.
 */
export function registrationOf(discovered: DiscoveredPlugin, exportName: string): PluginRegistration {
  return {
    manifest: identifiedManifest(discovered),
    entry: entryOnDisk(discovered.entryPath, discovered.entryPresent, exportName),
  };
}
