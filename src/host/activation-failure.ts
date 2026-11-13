import type { QuarantineReason } from "../core/index.js";

/** Why a plugin could not be activated, as the reason its quarantine carries; an entry's activate may throw one. */
export class ActivationFailure extends Error {
  readonly reason: QuarantineReason;

  constructor(detail: string, fix: string) {
    super(detail);
    this.name = "ActivationFailure";
    this.reason = { detail, fix };
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The reason a plugin whose activate threw `error` is quarantined with. */
export function activationFailureOf(error: unknown): ActivationFailure {
  if (error instanceof ActivationFailure) {
    return error;
  }
  return new ActivationFailure(`its activate threw: ${messageOf(error)}`, "make the plugin's activate return without throwing");
}
