import { order } from "../../engine/index.js";
import type { ActivationUnit } from "../../engine/index.js";
import type { Operation } from "../operation.js";

/**
 * @implNote A boot vector's units carry no kind, so every declaration is read as a service, the
 * only edge a plugin host draws. The plan's refusals are the answer: nothing is decided here. The
 * message is included so a vector can find both sides' names in the engine's own sentence.
 */
export const boot: Operation = (given) => {
  const plan = order(unitsOf(given.units), "service");
  const first = plan.refusals[0];
  return {
    started: plan.order,
    refusal: first === undefined ? null : { detail: first.detail, fix: first.fix, message: first.message },
  };
};

function unitsOf(declared: unknown): ActivationUnit[] {
  return arrayOf(declared).map((entry) => {
    const unit = entry as Record<string, unknown>;
    return {
      id: String(unit.id),
      provides: arrayOf(unit.provides).map((id) => ({ kind: "service" as const, id: String(id) })),
      requires: arrayOf(unit.requires).map((need) => {
        const { id, optional, degradable } = need as Record<string, unknown>;
        return { kind: "service" as const, id: String(id), optional: optional !== false, degradable: degradable === true };
      }),
    };
  });
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
