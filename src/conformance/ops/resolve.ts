import { budget, ServiceHub } from "../../engine/index.js";
import type { ConstraintEntry } from "../../engine/index.js";
import { ManualScheduler } from "../manual-scheduler.js";
import type { Operation } from "../operation.js";
import { ScriptedProvider } from "../scripted-provider.js";
import { settledTurn } from "./settlement.js";

/** Declared HERE because the engine mints none, exactly as the well-known service ids are. */
const VOCABULARY: readonly ConstraintEntry[] = [
  { constraintName: "minReplicas", attributeName: "maxReplicas", bound: "lower" },
  { constraintName: "maxLatencyMs", attributeName: "latencyMs", bound: "upper" },
];

const TICK_LIMIT = 200;

type Fields = Record<string, unknown>;

/**
 * @implNote Virtual time: the scheduler is fired by hand, so a 30 second budget costs nothing and
 * the engine still sees the budget the vector states. A settled want schedules nothing, so the
 * loop ends where `JavaDriver`'s ends; a turn then lets the promise reactions run.
 * @implNote `degraded` is read from a per-call sink being non-empty, as `JavaDriver` reads it.
 */
export const resolve: Operation = async (given) => {
  const requirement = fieldsOf(given.requirement);
  const provider = fieldsOf(given.provider);
  const serviceId = String(requirement.id);
  const reports: string[] = [];
  const clock = new ManualScheduler();
  const hub = new ServiceHub({
    scheduler: clock,
    diagnostics: (message) => reports.push(message),
    wellKnown: [serviceId],
    vocabulary: VOCABULARY,
  });
  const scripted = new ScriptedProvider(attributesByPoll(provider), provider.servesOnlyUnconstrained === true);
  hub.forConsumer("the-conformance-provider").register(serviceId, scripted, numbersOf(provider.advertised));

  let value: unknown;
  let failure: unknown;
  const asked = hub.forConsumer("the-conformance-consumer").want(
    {
      id: serviceId,
      optional: false,
      degradable: requirement.degradable === true,
      constraints: numbersOf(requirement.constraints),
    },
    budget(numberOr(given.budgetMillis, 30000), numberOr(given.pollMillis, 1000)),
  );
  asked.then(
    (served) => {
      value = served;
    },
    (reason: unknown) => {
      failure = reason;
    },
  );
  for (let tick = 0; tick < TICK_LIMIT && clock.nextDueMillis() !== undefined; tick++) clock.fireAll();
  await settledTurn();

  const degraded = reports.length > 0;
  return {
    served: value !== undefined && !degraded,
    degraded,
    atPoll: scripted.readsAtService,
    attributes: scripted.current(),
    report: degraded ? reports.join("\n") : null,
    refusal: refusalOf(failure),
    asks: scripted.asks,
  };
};

function refusalOf(failure: unknown): Fields | null {
  if (failure === undefined) return null;
  const fields = fieldsOf(failure);
  return { detail: fields.detail, fix: fields.fix, message: failure instanceof Error ? failure.message : String(failure) };
}

function attributesByPoll(provider: Fields): Record<string, number>[] {
  const scripted = Array.isArray(provider.attributesByPoll) ? provider.attributesByPoll.map(numbersOf) : [];
  return scripted.length > 0 ? scripted : [{}];
}

function fieldsOf(value: unknown): Fields {
  return typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {};
}

function numbersOf(value: unknown): Record<string, number> {
  const numbers: Record<string, number> = {};
  for (const [name, entry] of Object.entries(fieldsOf(value))) {
    if (typeof entry === "number") numbers[name] = entry;
  }
  return numbers;
}

function numberOr(value: unknown, absent: number): number {
  return typeof value === "number" ? value : absent;
}
