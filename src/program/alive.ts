import { isHostDestroyed, type HostDestroyed } from "../host/index.js";

/** The answer of a call on the run's host, which the run destroys only once it has ended. */
export function alive<Answer>(answer: Answer | HostDestroyed): Answer {
  if (isHostDestroyed(answer)) {
    throw new Error("The host was destroyed while the run still used it.");
  }
  return answer;
}
