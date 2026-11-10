import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { assertManifest, isIdentityId, isPluginError, localIdentity, pluginError, resolveManifest } from "../engine/index.js";
import type { Identity } from "../engine/index.js";
import type { PluginError, PluginManifest, SourceManifest } from "../index.js";

/** Deploy writes this beside the bundles so Node parses the whole directory as ESM, which is why the name can never be a plugin id. */
const ESM_MARKER_FILE = "package.json";

/** Deploy writes who a plugin is beside its sidecar, as `<importName>.identity.json`. */
const IDENTITY_SUFFIX = ".identity.json";

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
  /** Every plugin whose manifest validated, ordered by identity id. */
  loaded: DeployedPlugin[];
  /** One error per sidecar that could not be read or did not validate. */
  failed: PluginError[];
}

function entryFor(pluginDir: string, manifest: PluginManifest): string | null {
  if (!manifest.entry) return null;
  const deployed = join(pluginDir, `${manifest.importName}.js`);
  return existsSync(deployed) ? deployed : null;
}

interface PendingSidecar {
  manifestPath: string;
  filename: string;
  source: SourceManifest;
}

function failureFor(manifestPath: string, filename: string, error: unknown): PluginError {
  if (isPluginError(error)) return pluginError(filename, `${manifestPath}: ${error.detail}`, error.fix);
  return pluginError(
    filename,
    `${manifestPath} is not readable as JSON: ${String(error)}`,
    "redeploy the plugin so its plugin.json sidecar is written again"
  );
}

function identityRefusal(filename: string, identityPath: string, problem: string): PluginError {
  return pluginError(
    filename,
    `${identityPath}: ${problem}`,
    `redeploy the plugin so ${filename}.identity.json holds { "id": "<forge>:<repository id>", "name": "<repository name>" }`
  );
}

/** A missing identity file is a local plugin; a present one that cannot be trusted is refused, never read as local. */
function readIdentity(pluginDir: string, importName: string): Identity | PluginError {
  const identityPath = join(pluginDir, `${importName}${IDENTITY_SUFFIX}`);
  if (!existsSync(identityPath)) return localIdentity(importName);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(identityPath, "utf-8"));
  } catch (error) {
    return identityRefusal(importName, identityPath, `is not readable as JSON: ${String(error)}`);
  }
  const { id, name } = (typeof parsed === "object" && parsed !== null ? parsed : {}) as { id?: unknown; name?: unknown };
  if (typeof id !== "string" || typeof name !== "string" || name === "") {
    return identityRefusal(importName, identityPath, 'must be an object with a string "id" and a non-empty string "name"');
  }
  if (!isIdentityId(id)) {
    return identityRefusal(importName, identityPath, `the id "${id}" is not local:<name> or <forge>:<repository id>`);
  }
  return { id, name };
}

function pathsStating(pending: readonly PendingSidecar[], importName: string): string[] {
  return pending.filter((item) => item.source.importName === importName).map((item) => item.manifestPath);
}

function mismatchRefusal(item: PendingSidecar, pending: readonly PendingSidecar[]): PluginError {
  const stated = item.source.importName;
  const claimants = pathsStating(pending, stated);
  if (claimants.length > 1) {
    return pluginError(
      item.filename,
      `${item.manifestPath}: import name "${stated}" is stated by ${claimants.join(" and ")}`,
      "redeploy so exactly one sidecar states each import name"
    );
  }
  return pluginError(
    item.filename,
    `${item.manifestPath}: import name "${stated}" does not match filename "${item.filename}.json"`,
    "redeploy the plugin so the sidecar and bundle filenames match the declared import name"
  );
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

  const pending: PendingSidecar[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name === ESM_MARKER_FILE || name.endsWith(IDENTITY_SUFFIX)) continue;
    const manifestPath = join(pluginDir, name);
    const filename = basename(name, ".json");
    try {
      const source = assertManifest(JSON.parse(readFileSync(manifestPath, "utf-8")), ids(wellKnownServices));
      pending.push({ manifestPath, filename, source });
    } catch (error) {
      failed.push(failureFor(manifestPath, filename, error));
    }
  }

  for (const item of pending) {
    if (item.source.importName !== item.filename) {
      failed.push(mismatchRefusal(item, pending));
      continue;
    }
    const identity = readIdentity(pluginDir, item.filename);
    if (isPluginError(identity)) {
      failed.push(identity);
      continue;
    }
    const manifest = resolveManifest(item.source, identity);
    loaded.push({ manifest, manifestPath: item.manifestPath, entryPath: entryFor(pluginDir, manifest) });
  }

  loaded.sort((left, right) => (left.manifest.id < right.manifest.id ? -1 : left.manifest.id > right.manifest.id ? 1 : 0));

  return { loaded, failed };
}
