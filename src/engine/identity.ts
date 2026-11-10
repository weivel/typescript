import type { PluginManifest, SourceManifest } from "../index.js";

/** Who a repository is, supplied by whatever loaded it and never by its own manifest. */
export interface Identity {
  id: string;
  name: string;
}

const IDENTITY_ID = /^(local:[^/\s]+|[a-z][a-z0-9-]*(@[a-z0-9.-]+)?:[0-9]+)(\/[a-z0-9._-]+)*$/;

/** True for `local:<name>`, or a forge (with an optional `@host`) and a numeric repository id, then any path segments. */
export function isIdentityId(value: string): boolean {
  return IDENTITY_ID.test(value);
}

export function localIdentity(importName: string): Identity {
  return { id: `local:${importName}`, name: importName };
}

/** @implNote The identity is spread last, so an `id` or `name` a manifest states anyway never survives. */
export function resolveManifest(source: SourceManifest, identity: Identity): PluginManifest {
  return { ...source, id: identity.id, name: identity.name };
}

/**
 * The namespaced ids a manifest consumes that name no provider.
 *
 * @implNote A bare id names a host or shared service, which has no plugin to bind to, so it is never reported.
 */
export function unboundServices(manifest: { services?: PluginManifest["services"] }): string[] {
  const consumed = manifest.services?.consumes ?? [];
  return consumed.flatMap((entry) => {
    const { id, provider } = typeof entry === "string" ? { id: entry, provider: undefined } : entry;
    return isNamespaced(id) && provider === undefined ? [id] : [];
  });
}

function isNamespaced(serviceId: string): boolean {
  return serviceId.includes(":");
}
