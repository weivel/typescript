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

/**
 * What a call through a context answers once the core has forgotten its plugin: neither a success nor a refusal of
 * the core's, since the call never reached the core.
 *
 * @implNote The core may by then have issued the plugin's handle to another plugin, so a call made with it could act
 * for that other plugin.
 */
export class DetachedError extends Error {
  readonly plugin: bigint;

  constructor(plugin: bigint) {
    super(`The core has forgotten plugin ${plugin}, so its context reaches the core no more.`);
    this.name = "DetachedError";
    this.plugin = plugin;
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
