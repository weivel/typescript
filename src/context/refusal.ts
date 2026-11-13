import { RefusalCode, type CallResult, type CoreEvent, type Refusal } from "../core/index.js";

/** A refusal of the core, thrown or rejected as an Error that carries the refusal's data unchanged. */
export class RefusalError extends Error implements Refusal {
  readonly code: Refusal["code"];
  readonly detail: string | null;
  readonly fix: string | null;
  readonly subject: string | null;
  readonly hasFix: boolean;

  constructor(refusal: Refusal) {
    super(refusal.detail ?? `The weivel core refused with code ${refusal.code}.`);
    this.name = "RefusalError";
    this.code = refusal.code;
    this.detail = refusal.detail;
    this.fix = refusal.fix;
    this.subject = refusal.subject;
    this.hasFix = refusal.hasFix;
  }
}

function refusalOfEvent(event: CoreEvent): Refusal | undefined {
  switch (event.kind) {
    case "refusal":
    case "reach-refused":
      return event.refusal;
    case "want-settled":
      return event.refusal.code === RefusalCode.None ? undefined : event.refusal;
    default:
      return undefined;
  }
}

/** Why a call failed: the first refusal it drained, or its status when it drained none. */
export function failureOf(call: string, result: CallResult<unknown>): Error {
  for (const event of result.events) {
    const refusal = refusalOfEvent(event);
    if (refusal !== undefined) {
      return new RefusalError(refusal);
    }
  }
  return new Error(`${call} answered status ${result.status} and reported no refusal.`);
}
