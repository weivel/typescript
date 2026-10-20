import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { assertManifest, isPluginError, pluginError } from "../engine/index.js";
import type { PluginError, PluginManifest } from "../index.js";

/** Deploy writes this beside the bundles so Node parses the whole directory as ESM, which is why the name can never be a plugin id. */
const ESM_MARKER_FILE = "package.json";

/**
 * One entry of a declared vocabulary, which is the shape every typed key already has.
 *
 * @remarks
 * Declared structurally rather than imported so the scanner takes no value from a key-minting
 * library: a caller passes the keys it owns, whether they come from core, core-ir or its own module.
 */
export interface VocabularyEntry {
  id: string;
}

/** @internal */
export function ids(entries: ReadonlyArray<VocabularyEntry> | undefined): string[] {
  return entries === undefined ? [] : entries.map((entry) => entry.id);
}

/** One plugin as it sits deployed in a home: its manifest sidecar and the bundle beside it. */
export interface DeployedPlugin {
  /** The validated manifest. */
  manifest: PluginManifest;
  /** Absolute path of the sidecar this was read from. */
  manifestPath: string;
  /** Absolute path of the deployed bundle, or null when the plugin declares no entry or none is deployed. */
  entryPath: string | null;
}

/** What one scan of a home's plugin directory found, and what it could not read. */
export interface ManifestScan {
  /** Every plugin whose manifest validated, ordered by id. */
  loaded: DeployedPlugin[];
  /** One error per sidecar that could not be read or did not validate. */
  failed: PluginError[];
}

function entryFor(pluginDir: string, manifest: PluginManifest): string | null {
  if (!manifest.entry) return null;
  const deployed = join(pluginDir, `${manifest.id}.js`);
  return existsSync(deployed) ? deployed : null;
}

/**
 * Reads every manifest sidecar deployed in a home.
 *
 * @remarks
 * Deploy writes the manifest beside the bundle, so identity and capability questions are answered
 * from disk without importing anything. One unreadable sidecar becomes one entry in `failed` and
 * never discards the rest of the home, because a host that hides every plugin behind one bad file
 * is a host nobody can diagnose.
 *
 * @param pluginDir - the home's plugin directory, normally `<home>/plugin`
 * @param wellKnownServices - bare service ids any plugin may provide, none by default, so a host
 * that names none treats every bare id as squatting
 */
export function readDeployedManifests(pluginDir: string, wellKnownServices?: ReadonlyArray<VocabularyEntry>): ManifestScan {
  const loaded: DeployedPlugin[] = [];
  const failed: PluginError[] = [];

  let names: string[];
  try {
    names = readdirSync(pluginDir);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT") {
      return { loaded, failed };
    }
    failed.push(pluginError(
      "plugin-dir",
      `Plugin directory ${pluginDir} is not accessible: ${String(error)}`,
      "ensure the directory exists and is readable"
    ));
    return { loaded, failed };
  }

  const pendingLoad: Array<{ manifestPath: string; filename: string; manifest: PluginManifest }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    if (name === ESM_MARKER_FILE) continue;
    const manifestPath = join(pluginDir, name);
    const filename = basename(name, ".json");
    try {
      const manifest = assertManifest(JSON.parse(readFileSync(manifestPath, "utf-8")), ids(wellKnownServices));
      pendingLoad.push({ manifestPath, filename, manifest });
    } catch (error) {
      let detail: string;
      let fix: string;
      if (isPluginError(error)) {
        detail = `${manifestPath}: ${error.detail}`;
        fix = error.fix;
      } else {
        detail = `${manifestPath} is not readable as JSON: ${String(error)}`;
        fix = "redeploy the plugin so its plugin.json sidecar is written again";
      }
      failed.push(pluginError(filename, detail, fix));
    }
  }

  for (const item of pendingLoad) {
    if (item.manifest.id !== item.filename) {
      failed.push(pluginError(
        item.filename,
        `${item.manifestPath}: plugin id "${item.manifest.id}" does not match filename "${item.filename}.json"`,
        "redeploy the plugin so the sidecar and bundle filenames match the declared id"
      ));
      continue;
    }
    loaded.push({ manifest: item.manifest, manifestPath: item.manifestPath, entryPath: entryFor(pluginDir, item.manifest) });
  }

  loaded.sort((left, right) => {
    const leftId = left.manifest.id;
    const rightId = right.manifest.id;
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });

  return { loaded, failed };
}
