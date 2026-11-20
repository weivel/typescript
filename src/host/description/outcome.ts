import { Status } from "../../core/constants.js";

/** What a described operation resolves with when it answered WEIVEL_STATUS_NONE: neither an answer nor a refusal. */
export const none: unique symbol = Symbol("weivel.none");

const statusNames: Readonly<Record<number, string>> = {
  [Status.Malformed]: "malformed",
  [Status.Refused]: "refused",
  [Status.OutOfMemory]: "out of memory",
};

/**
 * A described operation that answered a status other than OK or NONE: `status` is the weivel_status it returned, and
 * `detail` and `fix` the refusal's texts, which only a REFUSED status carries.
 */
export class DescribedCallError extends Error {
  readonly operation: string;
  readonly status: number;
  readonly detail: string | null;
  readonly fix: string | null;

  constructor(operation: string, status: number, detail: string | null, fix: string | null) {
    const name = statusNames[status] ?? `status ${status}`;
    super(detail === null ? `${operation} answered ${name}.` : `${operation} answered ${name}: ${detail}${fix === null ? "" : ` (${fix})`}`);
    this.name = "DescribedCallError";
    this.operation = operation;
    this.status = status;
    this.detail = detail;
    this.fix = fix;
  }
}
