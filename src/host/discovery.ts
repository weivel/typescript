import { Status, type Core, type Manifest } from "../core/index.js";
import { failureOf, RefusalError } from "../context/index.js";
import { identifiedManifest, type DiscoveredPlugin, type Standard, type ValidationOptions } from "../standard/index.js";
import type { DiscoveryReport, HostedPlugin, RefusedPlugin, UnsupportedPlugin } from "./model.js";

interface Sorted {
  readonly registered: HostedPlugin[];
  readonly unsupported: UnsupportedPlugin[];
  readonly refused: RefusedPlugin[];
}

/** The manifest the core registers: the identity file's id on a copy when the standard found one. */
function manifestOf(discovered: DiscoveredPlugin): Manifest {
  return discovered.identityId === null ? discovered.manifest : identifiedManifest(discovered);
}

function sortOne(core: Core, discovered: DiscoveredPlugin, sorted: Sorted): void {
  const manifest = manifestOf(discovered);
  const manifestPath = discovered.manifestPath;
  const support = core.supports(manifest);
  if (support.status !== Status.Ok || support.value === undefined) {
    throw failureOf("weivel_supports", support);
  }
  if (!support.value.supported) {
    sorted.unsupported.push({ manifestPath, manifest, support: support.value });
    return;
  }
  const registered = core.registerManifest(manifest);
  if (registered.status === Status.Ok && registered.value !== undefined) {
    sorted.registered.push({ plugin: registered.value, manifest, manifestPath, entryPath: discovered.entryPath });
    return;
  }
  const failure = failureOf("weivel_register_manifest", registered);
  if (!(failure instanceof RefusalError)) {
    throw failure;
  }
  sorted.refused.push({ manifestPath, manifest, refusal: failure });
}

/**
 * Discovers the plugins in `directory` with the standard, asks the core whether each is supported, and registers
 * the supported ones, in the standard's order.
 *
 * @throws Error when the core answers a call malformed, which is a defect of this layer, not a plugin's.
 */
export function discoverPlugins(core: Core, standard: Standard, directory: string, options: ValidationOptions): DiscoveryReport {
  const discovery = standard.discover(directory, options);
  if (discovery.value === undefined) {
    return { refusal: discovery.refusal, registered: [], unsupported: [], refused: [], failures: [] };
  }
  const sorted: Sorted = { registered: [], unsupported: [], refused: [] };
  for (const discovered of discovery.value.plugins) {
    sortOne(core, discovered, sorted);
  }
  return { refusal: undefined, ...sorted, failures: discovery.value.failures };
}
