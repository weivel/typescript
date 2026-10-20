export interface ManifestFacts {
  id: string;
  api: number;
  capabilities: string[];
  permissions: string[];
  targets: string[];
  payload: unknown;
}

type Fields = Record<string, unknown>;

/**
 * Extracts the facts a host decides with.
 *
 * @implNote The payload is the argument itself, by identity, which keeps the engine free of a
 * manifest type: whatever the host parsed comes back on the session unchanged. Fields the engine
 * does not decide with, such as `languages` and `implementation`, are never read (invariant 3).
 */
export function factsOf(manifest: unknown): ManifestFacts {
  const fields: Fields = typeof manifest === "object" && manifest !== null ? (manifest as Fields) : {};
  return {
    id: typeof fields.id === "string" ? fields.id : "",
    api: typeof fields.api === "number" ? fields.api : 0,
    capabilities: stringsOf(fields.capabilities),
    permissions: stringsOf(fields.permissions),
    targets: stringsOf(fields.targets),
    payload: manifest,
  };
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
