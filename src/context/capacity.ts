import {
  CapacityQuestion,
  Choice,
  type CapacityAnswer,
  type CapacityWantedEvent,
  type NamedNumber,
} from "../core/index.js";
import type { CapacityProvider } from "./model.js";
import type { ContextState } from "./state.js";

function asCapacityProvider(object: unknown): CapacityProvider {
  return (typeof object === "object" && object !== null) || typeof object === "function" ? (object as CapacityProvider) : {};
}

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
 * @remarks A provider that throws is logged on its owner's log and left unanswered, which the core reads as "not
 * right now" when the question's time ends.
 */
export function answerCapacity(state: ContextState, event: CapacityWantedEvent): void {
  const offered = state.services.lookup(event.registration);
  if (offered === undefined) {
    return;
  }
  let answer: CapacityAnswer | undefined;
  try {
    answer = answerOf(asCapacityProvider(offered.object), event);
  } catch (error) {
    state.logOf(offered.owner).error(`The provider of ${offered.id} threw while asked about its capacity.`, error);
    return;
  }
  if (answer !== undefined) {
    const answered = answer;
    state.call(() => state.core.reportCapacity(event.want, event.registration, answered, state.clock.now()));
  }
}
