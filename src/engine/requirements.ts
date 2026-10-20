import type { ManifestOffer, ManifestRequirement } from "../index.js";

export interface ServiceRequirement {
  readonly id: string;
  readonly optional: boolean;
  readonly degradable: boolean;
  readonly constraints: Readonly<Record<string, number>>;
}

export interface ServiceOffer {
  readonly id: string;
  readonly attributes: Readonly<Record<string, number>>;
}

/**
 * Reads one entry of `services.consumes`.
 *
 * @implNote A bare id reads as optional and not degradable, which is what every manifest written
 * before the object form already meant: a consumed service nobody provided drew no edge and the
 * consumer activated anyway. An object form defaults the same way, so `{ "id": "a:x" }` orders and
 * refuses exactly like the bare `"a:x"`.
 */
export function readRequirement(declaration: string | ManifestRequirement): ServiceRequirement {
  if (typeof declaration === "string") {
    return { id: declaration, optional: true, degradable: false, constraints: {} };
  }
  return {
    id: declaration.id,
    optional: flag(declaration.optional, true),
    degradable: flag(declaration.degradable, false),
    constraints: numbersOf(declaration.constraints),
  };
}

/** Reads one entry of `services.provides`, whichever form it is written in. */
export function readOffer(declaration: string | ManifestOffer): ServiceOffer {
  if (typeof declaration === "string") {
    return { id: declaration, attributes: {} };
  }
  return { id: declaration.id, attributes: numbersOf(declaration.attributes) };
}

function flag(value: unknown, absent: boolean): boolean {
  return typeof value === "boolean" ? value : absent;
}

function numbersOf(value: unknown): Record<string, number> {
  const numbers: Record<string, number> = {};
  if (typeof value !== "object" || value === null) {
    return numbers;
  }
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === "number") {
      numbers[name] = entry;
    }
  }
  return numbers;
}
