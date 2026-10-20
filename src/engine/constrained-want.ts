import type { Scheduler } from "../index.js";
import { budgetFault, satisfies, unknownIn } from "./constraints.js";
import type { Budget, ConstraintEntry } from "./constraints.js";
import type { DiagnosticSink } from "./diagnostics.js";
import { pluginError } from "./errors.js";
import type { ServiceRequirement } from "./requirements.js";

type Attributes = Readonly<Record<string, number>>;

/** One registration as a constrained want sees it. */
export interface Offering {
  readonly advertised: Attributes;
  attributes(): unknown;
  /** The handle served under these constraints, or undefined when the provider will not serve. */
  serve(constraints: Attributes): unknown;
}

export interface WantSeam {
  readonly scheduler: Scheduler;
  readonly diagnostics: DiagnosticSink;
  readonly vocabulary: readonly ConstraintEntry[];
  offering(serviceId: string): Offering | undefined;
}

/**
 * One consumer's constrained wait for a service: re-ask to a budget, then degrade with a report or
 * refuse.
 *
 * @remarks
 * The budget is spent in ticks on the host's scheduler, never slept (invariant 8), which is also
 * what lets a test spend a 30 second budget instantly.
 */
export class ConstrainedWant {
  readonly settled: Promise<unknown>;
  private resolve: (service: unknown) => void = () => {};
  private reject: (reason: unknown) => void = () => {};
  private seen: Attributes = {};
  private elapsed = 0;
  private cancelPoll: () => void = () => {};
  private done = false;

  constructor(
    private readonly seam: WantSeam,
    private readonly consumerId: string,
    private readonly requirement: ServiceRequirement,
    private readonly budget: Budget,
    private readonly onSettled: () => void,
  ) {
    this.settled = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  get serviceId(): string {
    return this.requirement.id;
  }

  start(): Promise<unknown> {
    const fault = budgetFault(this.budget);
    if (fault !== undefined) {
      this.fail(
        pluginError(
          this.consumerId,
          `asked for "${this.requirement.id}" under ${fault}`,
          "build the budget with budget(budgetMillis, pollMillis)",
        ),
      );
      return this.settled;
    }
    for (const unknown of unknownIn(this.seam.vocabulary, this.requirement.constraints)) {
      this.seam.diagnostics(
        `constraint "${unknown}" is in no vocabulary this host declared, so nothing can satisfy it for ${this.consumerId}`,
      );
    }
    this.attempt();
    return this.settled;
  }

  /**
   * Gives up on behalf of a consumer that is no longer running.
   *
   * @implNote Without this a released plugin keeps spending its budget: the ticks call into
   * providers on its behalf and can hand it a service minutes after the host stopped it.
   */
  stop(reason: unknown): void {
    if (this.done) return;
    this.cancelPoll();
    this.fail(reason);
  }

  /**
   * @implNote A provider is plugin code and may throw. A throw is reported and read as "not yet",
   * so the budget still ends in a degrade or a refusal; escaping inside a scheduled tick would leave
   * the want pending for the life of the process.
   */
  private attempt(): void {
    if (this.done) return;
    const offering = this.seam.offering(this.requirement.id);
    if (offering !== undefined && this.servedNow(offering)) return;
    if (this.elapsed >= this.budget.budgetMillis) {
      this.degradeOrRefuse(offering);
      return;
    }
    this.elapsed += this.budget.pollMillis;
    this.cancelPoll = this.seam.scheduler.schedule(() => this.attempt(), this.budget.pollMillis);
  }

  private servedNow(offering: Offering): boolean {
    try {
      this.seen = overlay(offering.advertised, offering.attributes());
      if (!satisfies(this.seam.vocabulary, this.requirement.constraints, this.seen)) return false;
      const served = offering.serve(this.requirement.constraints);
      if (served === undefined) return false;
      this.succeed(served);
      return true;
    } catch (failure) {
      this.seam.diagnostics(
        `the provider of "${this.requirement.id}" threw while ${this.consumerId} was waiting for it: ${String(failure)}`,
      );
      return false;
    }
  }

  /**
   * @implNote Degradation is never silent: what was accepted is reported before it is handed over.
   * The consumer's own constraints are asked once more first, because the provider may have started
   * satisfying them in the instant after the budget ran out (binding 9.3, rule 3).
   */
  private degradeOrRefuse(offering: Offering | undefined): void {
    if (!this.requirement.degradable || offering === undefined) {
      this.fail(this.unsatisfied(offering));
      return;
    }
    const served = this.servedOrUndefined(offering, this.requirement.constraints) ?? this.servedOrUndefined(offering, {});
    if (served === undefined) {
      this.fail(
        pluginError(
          this.consumerId,
          `needs "${this.requirement.id}", and its provider would not serve even an unconstrained ask`,
          "have the provider serve an unconstrained ask, or stop declaring the requirement degradable",
        ),
      );
      return;
    }
    this.seam.diagnostics(
      `${this.consumerId} accepted a degraded "${this.requirement.id}": it asked for ${describe(this.requirement.constraints)} and was offered ${describe(this.seen)}`,
    );
    this.succeed(served);
  }

  private servedOrUndefined(offering: Offering, constraints: Attributes): unknown {
    try {
      return offering.serve(constraints);
    } catch (failure) {
      this.seam.diagnostics(
        `the provider of "${this.requirement.id}" threw while serving ${this.consumerId}: ${String(failure)}`,
      );
      return undefined;
    }
  }

  private unsatisfied(offering: Offering | undefined): Error {
    const offered = offering === undefined ? "nothing provides it" : `its provider still offers ${describe(this.seen)}`;
    return pluginError(
      this.consumerId,
      `needs "${this.requirement.id}" meeting ${describe(this.requirement.constraints)}, and after ${this.budget.budgetMillis} ms ${offered}`,
      `run a provider that meets ${describe(this.requirement.constraints)}, or mark the requirement degradable to accept what there is`,
    );
  }

  private succeed(service: unknown): void {
    this.done = true;
    this.onSettled();
    this.resolve(service);
  }

  private fail(reason: unknown): void {
    this.done = true;
    this.onSettled();
    this.reject(reason);
  }
}

/**
 * @implNote Per key, never a choice between the two: a provider reporting only the one attribute
 * that changes live would otherwise drop every claim its declaration made (binding 9.3, rule 1).
 */
function overlay(advertised: Attributes, live: unknown): Attributes {
  const merged: Record<string, number> = { ...advertised };
  if (typeof live !== "object" || live === null) return merged;
  for (const [name, value] of Object.entries(live)) {
    if (typeof value === "number") merged[name] = value;
  }
  return merged;
}

function describe(attributes: Attributes): string {
  return JSON.stringify(attributes);
}
