import type { ServiceProvider } from "../engine/index.js";

/**
 * A provider whose live attributes are scripted per read, and which records what it was asked.
 *
 * @implNote The script is clamped at its last entry rather than running out, so a budget that
 * outlasts it keeps reporting the last state instead of reverting to the declaration's claim,
 * which is a different vector's subject.
 */
export class ScriptedProvider implements ServiceProvider {
  /** One entry per ask to serve, true when it carried the consumer's constraints. */
  readonly asks: boolean[] = [];
  readsAtService = 0;
  private reads = 0;

  constructor(
    private readonly byRead: readonly Record<string, number>[],
    private readonly servesOnlyUnconstrained: boolean,
  ) {}

  attributes(): Record<string, number> {
    this.reads++;
    return this.current();
  }

  serviceFor(constraints: Record<string, number>): unknown | undefined {
    const carriedTheConsumersConstraints = Object.keys(constraints).length > 0;
    this.asks.push(carriedTheConsumersConstraints);
    if (this.servesOnlyUnconstrained && carriedTheConsumersConstraints) return undefined;
    this.readsAtService = this.reads;
    return "the conformance service";
  }

  current(): Record<string, number> {
    const index = Math.min(Math.max(this.reads, 1), this.byRead.length) - 1;
    return { ...this.byRead[index] };
  }
}
