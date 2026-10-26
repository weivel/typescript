import type { PluginError, PluginManifest } from "../index.js";
import { pluginError } from "./errors.js";
import { readOffer, readRequirement } from "./requirements.js";

export type DeclarationKind = "service" | "capability";

export interface Offer {
  kind: DeclarationKind;
  id: string;
}

export interface Need {
  kind: DeclarationKind;
  id: string;
  optional: boolean;
  degradable: boolean;
}

export interface ActivationUnit {
  id: string;
  provides: Offer[];
  requires: Need[];
}

export interface ActivationPlan {
  order: string[];
  cycles: string[][];
  refusals: PluginError[];
}

type Dependencies = Map<string, Set<string>>;

/**
 * Sorts units so a provider activates before its consumers, and refuses the ones whose mandatory
 * needs nothing in the set meets.
 *
 * @param edgeSource which kind of declaration draws the edges; declarations of the other kind are
 * ignored entirely, for ordering and for refusal alike
 * @param hostProvided - service ids the host itself supplies. They meet a mandatory need exactly as
 * a unit's offer would, but the host is never activated, refused or listed in the order.
 * @throws when two units share an id, which is a caller bug rather than a configuration
 * @implNote A cycle member is NOT refused: the cycle it is reported in is already the account of
 * why it did not start. It does stop being a provider, and so does a refused unit, so refusal
 * runs to a fixpoint over the units that will actually start.
 * @implNote A degradable need is a different axis from an optional one: it never excuses an absence.
 * @implNote The host is modelled as a unit that offers its services and needs nothing, so the
 * refusal fixpoint, which cascades, sees them as providers from its first pass instead of
 * filtering refusals afterwards.
 */
export function order(
  units: readonly ActivationUnit[],
  edgeSource: DeclarationKind,
  hostProvided: readonly string[] = [],
): ActivationPlan {
  if (hostProvided.length === 0) {
    return orderUnits(units, edgeSource);
  }
  const host: ActivationUnit = { id: HOST_UNIT_ID, provides: hostProvided.map((id) => ({ kind: "service" as const, id })), requires: [] };
  const plan = orderUnits([...units, host], edgeSource);
  return { ...plan, order: plan.order.filter((id) => id !== HOST_UNIT_ID) };
}

const HOST_UNIT_ID = String.fromCharCode(0) + "host";

function orderUnits(units: readonly ActivationUnit[], edgeSource: DeclarationKind): ActivationPlan {
  refuseDuplicateIds(units);
  const refusedIds = new Set<string>();
  const refusals: PluginError[] = [];
  let ids: string[];
  let dependencies: Dependencies;
  let cycles: string[][];
  do {
    ids = units.filter((unit) => !refusedIds.has(unit.id)).map((unit) => unit.id);
    dependencies = dependenciesOf(units, refusedIds, edgeSource);
    cycles = findCycles(ids, dependencies);
  } while (refuseUnmet(units, refusedIds, unavailableOf(refusedIds, cycles), refusals, edgeSource));
  return { order: sequence(ids, dependencies, cycles), cycles, refusals };
}

/** Units for a plugin host: what each manifest provides and consumes, all as services. */
export function unitsFromManifests(manifests: readonly PluginManifest[]): ActivationUnit[] {
  return manifests.map((manifest) => ({
    id: manifest.id,
    provides: (manifest.services?.provides ?? []).map((declaration) => ({
      kind: "service" as const,
      id: readOffer(declaration).id,
    })),
    requires: (manifest.services?.consumes ?? []).map((declaration) => {
      const { id, optional, degradable } = readRequirement(declaration);
      return { kind: "service" as const, id, optional, degradable };
    }),
  }));
}

/**
 * The order a plugin host activates manifests in.
 *
 * @param hostProvided - service ids the host itself supplies, as {@link order} takes them
 */
export function activationOrder(manifests: readonly PluginManifest[], hostProvided: readonly string[] = []): ActivationPlan {
  return order(unitsFromManifests(manifests), "service", hostProvided);
}

function unavailableOf(refusedIds: ReadonlySet<string>, cycles: readonly string[][]): Set<string> {
  return new Set([...refusedIds, ...cycles.flat()]);
}

function refuseDuplicateIds(units: readonly ActivationUnit[]): void {
  const seen = new Set<string>();
  for (const unit of units) {
    if (seen.has(unit.id)) {
      throw new Error(`two units share the id "${unit.id}", and everything here is keyed by id: give each one its own`);
    }
    seen.add(unit.id);
  }
}

function providersOf(
  units: readonly ActivationUnit[],
  excluded: ReadonlySet<string>,
  edgeSource: DeclarationKind,
): Map<string, string[]> {
  const providers = new Map<string, string[]>();
  for (const unit of units) {
    if (excluded.has(unit.id)) {
      continue;
    }
    for (const offer of unit.provides) {
      if (offer.kind === edgeSource) {
        providers.set(offer.id, [...(providers.get(offer.id) ?? []), unit.id]);
      }
    }
  }
  return providers;
}

function dependenciesOf(
  units: readonly ActivationUnit[],
  refusedIds: ReadonlySet<string>,
  edgeSource: DeclarationKind,
): Dependencies {
  const providers = providersOf(units, refusedIds, edgeSource);
  const dependencies: Dependencies = new Map();
  for (const unit of units) {
    if (refusedIds.has(unit.id)) {
      continue;
    }
    const needed = new Set<string>();
    for (const need of unit.requires) {
      if (need.kind !== edgeSource) {
        continue;
      }
      for (const provider of providers.get(need.id) ?? []) {
        if (provider !== unit.id) {
          needed.add(provider);
        }
      }
    }
    dependencies.set(unit.id, needed);
  }
  return dependencies;
}

/**
 * @implNote Run against the units that will actually START, which is why the caller re-runs it
 * after recomputing the cycles. A unit refused for its own missing need stops being a provider,
 * and so does a unit held out of the order by a cycle.
 *
 * @returns true when this pass refused at least one more unit, so the graph has to be recomputed
 */
function refuseUnmet(
  units: readonly ActivationUnit[],
  refusedIds: Set<string>,
  unavailable: ReadonlySet<string>,
  refusals: PluginError[],
  edgeSource: DeclarationKind,
): boolean {
  const providers = providersOf(units, unavailable, edgeSource);
  let refusedMore = false;
  for (const unit of units) {
    if (unavailable.has(unit.id)) {
      continue;
    }
    const unmet = unit.requires.find(
      (need) => need.kind === edgeSource && !need.optional && (providers.get(need.id) ?? []).length === 0,
    );
    if (unmet !== undefined) {
      refusedIds.add(unit.id);
      refusals.push(
        pluginError(
          unit.id,
          `requires "${unmet.id}", which nothing here provides`,
          `install something that provides "${unmet.id}", or mark the requirement optional`,
        ),
      );
      refusedMore = true;
    }
  }
  return refusedMore;
}

function sequence(ids: readonly string[], dependencies: Dependencies, cycles: readonly string[][]): string[] {
  const settled = new Set(cycles.flat());
  const sequenced: string[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const id of ids) {
      if (settled.has(id) || [...(dependencies.get(id) ?? [])].some((dependency) => !settled.has(dependency))) {
        continue;
      }
      sequenced.push(id);
      settled.add(id);
      progressed = true;
    }
  }
  return sequenced;
}

/**
 * @implNote Tarjan's strongly-connected components. A component of one is not a cycle, and each
 * reported component is reversed so the message reads as a chain, dependency first.
 */
function findCycles(ids: readonly string[], dependencies: Dependencies): string[][] {
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const visit = (id: string): void => {
    index.set(id, index.size);
    lowLink.set(id, index.get(id) as number);
    stack.push(id);
    onStack.add(id);
    for (const dependency of dependencies.get(id) ?? []) {
      if (!index.has(dependency)) {
        visit(dependency);
        lowLink.set(id, Math.min(lowLink.get(id) as number, lowLink.get(dependency) as number));
      } else if (onStack.has(dependency)) {
        lowLink.set(id, Math.min(lowLink.get(id) as number, index.get(dependency) as number));
      }
    }
    if (lowLink.get(id) !== index.get(id)) {
      return;
    }
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop() as string;
      onStack.delete(member);
      component.push(member);
    } while (member !== id);
    if (component.length > 1) {
      cycles.push(component.reverse());
    }
  };

  for (const id of ids) {
    if (!index.has(id)) {
      visit(id);
    }
  }
  return cycles;
}
