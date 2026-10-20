/**
 * Which constraint name is compared against which advertised attribute, and in which direction.
 *
 * @remarks
 * Supplied by the host, never held here: this package mints no vocabulary, and an engine that knew
 * `minReplicas` would be one product's engine (binding 9.3, rule 2).
 */
export interface ConstraintEntry {
  constraintName: string;
  attributeName: string;
  /** `lower` means the advertised value must be at least the constraint, `upper` at most. */
  bound: "lower" | "upper";
}

/** How long a consumer re-asks for a service that does not satisfy it yet, and how often. */
export interface Budget {
  budgetMillis: number;
  pollMillis: number;
}

/**
 * A registration that answers for itself: what it offers now, and whether it serves a consumer
 * asking under constraints.
 *
 * @remarks
 * An empty `attributes()` means nothing live to add, which leaves the advertised claim standing.
 * `serviceFor` answers undefined when it will not serve under those constraints.
 */
export interface ServiceProvider {
  attributes(): Record<string, number>;
  serviceFor(constraints: Record<string, number>): unknown | undefined;
}

/** @throws when `pollMillis` is not positive, which would spend no budget per poll and re-ask for ever. */
export function budget(budgetMillis: number, pollMillis: number): Budget {
  if (!(pollMillis > 0)) {
    throw new RangeError(`a budget polling every ${pollMillis} ms never reaches its deadline: give it a positive interval`);
  }
  return { budgetMillis, pollMillis };
}

export function isServiceProvider(value: unknown): value is ServiceProvider {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  return typeof Reflect.get(value, "attributes") === "function" && typeof Reflect.get(value, "serviceFor") === "function";
}

/**
 * Whether what a provider offers meets everything a consumer declared.
 *
 * @implNote A constraint no entry covers is NOT met: treating it as met would let a typo in a
 * manifest read as a requirement nothing has to meet.
 */
export function satisfies(
  vocabulary: readonly ConstraintEntry[],
  declared: Readonly<Record<string, number>>,
  attributes: Readonly<Record<string, number>>,
): boolean {
  return Object.entries(declared).every(([name, wanted]) => {
    const known = entryFor(vocabulary, name);
    const offered = known === undefined ? undefined : attributes[known.attributeName];
    if (known === undefined || typeof offered !== "number") return false;
    return known.bound === "upper" ? offered <= wanted : offered >= wanted;
  });
}

/**
 * The declared constraint names no entry covers, in declaration order.
 *
 * @implNote Separate from `satisfies` so a caller reports them once rather than once per poll.
 */
export function unknownIn(vocabulary: readonly ConstraintEntry[], declared: Readonly<Record<string, number>>): string[] {
  return Object.keys(declared).filter((name) => entryFor(vocabulary, name) === undefined);
}

function entryFor(vocabulary: readonly ConstraintEntry[], constraintName: string): ConstraintEntry | undefined {
  return vocabulary.find((entry) => entry.constraintName === constraintName);
}
