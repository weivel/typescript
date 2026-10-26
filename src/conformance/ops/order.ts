import { order as planOrder } from "../../engine/index.js";
import type { ActivationUnit, DeclarationKind } from "../../engine/index.js";
import type { Operation } from "../operation.js";

export const order: Operation = (given) => {
  const edgeSource = given.edgeSource === "capabilities" ? "capability" : "service";
  const hostProvided = arrayOf(given.hostProvided).map(String);
  const plan = planOrder(unitsOf(given.units), edgeSource, hostProvided);
  return { order: plan.order, cycle: plan.cycles[0] ?? null };
};

function unitsOf(declared: unknown): ActivationUnit[] {
  return arrayOf(declared).map((entry) => {
    const unit = entry as Record<string, unknown>;
    return {
      id: String(unit.id),
      provides: arrayOf(unit.provides).map((offer) => {
        const { id, kind } = offer as Record<string, unknown>;
        return { kind: kindOf(kind), id: String(id) };
      }),
      requires: arrayOf(unit.requires).map((need) => {
        const { id, kind, optional, degradable } = need as Record<string, unknown>;
        return { kind: kindOf(kind), id: String(id), optional: optional !== false, degradable: degradable === true };
      }),
    };
  });
}

function kindOf(declared: unknown): DeclarationKind {
  return declared === "capability" ? "capability" : "service";
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
