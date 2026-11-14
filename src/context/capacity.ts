import {
  CapacityQuestion,
  Choice,
  Status,
  type CapacityAnswer,
  type CapacityWantedEvent,
  type NamedNumber,
} from "../core/index.js";
import type { CapacityProvider } from "./model.js";
import { failureOf } from "./refusal.js";
import type { ContextState } from "./state.js";

/** A registration that declared no capacity provider: no live attributes, and it serves every consumer. */
const plainRegistration: CapacityProvider = {};

function liveAttributes(provider: CapacityProvider): NamedNumber[] {
  if (typeof provider.attributes !== "function") {
    return [];
  }
  return Object.entries(provider.attributes())
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .map(([name, value]) => ({ name, value }));
}

function servesUnder(provider: CapacityProvider, constraints: readonly NamedNumber[]): boolean {
  if (typeof provider.serves !== "function") {
    return true;
  }
  return provider.serves(Object.fromEntries(constraints.map((constraint) => [constraint.name, constraint.value]))) === true;
}

/** The provider's answer to the question, or undefined for a question this layer does not know. */
function answerOf(provider: CapacityProvider, event: CapacityWantedEvent): CapacityAnswer | undefined {
  switch (event.question) {
    case CapacityQuestion.Attributes:
      return { request: event.request, attributes: liveAttributes(provider) };
    case CapacityQuestion.Serve:
      return { request: event.request, serves: servesUnder(provider, event.constraints) ? Choice.Yes : Choice.No };
    default:
      return undefined;
  }
}

/**
 * Puts a constrained want's question to the provider's object and reports its answer to the core.
 *
 * @remarks A provider that throws is reported to the error sink and left unanswered, which the core reads as "not
 * right now" when the question's time ends. A question that arrived incomplete is left unanswered the same way and
 * put to no one: its constraints are missing rather than empty, and the wrapper that marked it told the sink.
 */
export function answerCapacity(state: ContextState, event: CapacityWantedEvent): void {
  const offered = state.services.lookup(event.registration);
  if (offered === undefined || event.incomplete === true) {
    return;
  }
  let answer: CapacityAnswer | undefined;
  try {
    answer = answerOf(offered.capacity ?? plainRegistration, event);
  } catch (error) {
    state.core.reportListenerError(error, event);
    return;
  }
  if (answer !== undefined) {
    reportAnswer(state, event, answer);
  }
}

/**
 * Hands the answer to the core. One it does not take is reported to the error sink, its question left unanswered,
 * since the answerer has no caller to hear it; NONE is an answer that came after its question closed, no failure.
 */
function reportAnswer(state: ContextState, event: CapacityWantedEvent, answer: CapacityAnswer): void {
  const reported = state.call(() => state.core.reportCapacity(event.want, event.registration, answer, state.clock.now()));
  if (reported.status !== Status.Ok && reported.status !== Status.None) {
    state.core.reportListenerError(failureOf("weivel_report_capacity", reported), event);
  }
}
