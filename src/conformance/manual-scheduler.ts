import type { Scheduler } from "../index.js";

interface Tick {
  task: () => void;
  dueMillis: number;
}

/**
 * The clock a driver or a host test advances by hand.
 *
 * @remarks
 * A vector's budget is logical, so a 30 second one must cost no wall clock: every scheduled tick
 * runs the moment the caller asks for it.
 */
export class ManualScheduler implements Scheduler {
  private pending: Tick[] = [];
  private nowMillis = 0;

  schedule(task: () => void, delayMillis: number): () => void {
    const tick: Tick = { task, dueMillis: this.nowMillis + Math.max(0, delayMillis) };
    this.pending.push(tick);
    return () => {
      this.pending = this.pending.filter((candidate) => candidate !== tick);
    };
  }

  now(): number {
    return this.nowMillis;
  }

  /** Runs every tick scheduled so far, whenever it is due, without moving the clock. */
  fireAll(): void {
    const due = this.pending;
    this.pending = [];
    for (const tick of due) {
      tick.task();
    }
  }

  /** Moves the clock to `millis`, running each due tick earliest first, including ticks scheduled on the way. */
  advanceTo(millis: number): void {
    for (let next = this.earliestDueBy(millis); next !== undefined; next = this.earliestDueBy(millis)) {
      this.pending = this.pending.filter((candidate) => candidate !== next);
      this.nowMillis = next.dueMillis;
      next.task();
    }
    this.nowMillis = Math.max(this.nowMillis, millis);
  }

  /** The due time of the earliest pending tick, or undefined when nothing is scheduled. */
  nextDueMillis(): number | undefined {
    return this.earliestDueBy(Infinity)?.dueMillis;
  }

  private earliestDueBy(millis: number): Tick | undefined {
    let earliest: Tick | undefined;
    for (const tick of this.pending) {
      if (tick.dueMillis <= millis && (earliest === undefined || tick.dueMillis < earliest.dueMillis)) {
        earliest = tick;
      }
    }
    return earliest;
  }
}
