import { Status, type Core } from "../core/index.js";

/** The caller's monotonic time in whole milliseconds, the scale every time handed to the core is on. */
export interface Clock {
  now(): number;
}

export interface Scheduler {
  schedule(callback: () => void, delayMilliseconds: number): unknown;
  cancel(token: unknown): void;
}

export const systemClock: Clock = { now: () => Math.floor(performance.now()) };

export const systemScheduler: Scheduler = {
  schedule: (callback, delayMilliseconds) => setTimeout(callback, delayMilliseconds),
  cancel: (token) => clearTimeout(token as ReturnType<typeof setTimeout>),
};

/** setTimeout's largest delay; a later deadline is reached by re-arming when the shorter wait ends. */
const LONGEST_DELAY_MILLISECONDS = 2_147_483_647;

export interface CoreTimerOptions {
  readonly clock?: Clock;
  readonly scheduler?: Scheduler;
}

interface Armed {
  readonly deadline: number;
  readonly token: unknown;
}

/**
 * Keeps one timer armed for the core's next deadline: re-armed after every drain from weivel_next_deadline,
 * cancelled when the core answers none, and on firing tells the core the time with weivel_advance.
 */
export class CoreTimer {
  readonly #core: Core;
  readonly #clock: Clock;
  readonly #scheduler: Scheduler;
  readonly #removeDrainListener: () => void;
  #armed: Armed | undefined;
  #rearming = false;

  constructor(core: Core, options: CoreTimerOptions = {}) {
    this.#core = core;
    this.#clock = options.clock ?? systemClock;
    this.#scheduler = options.scheduler ?? systemScheduler;
    this.#removeDrainListener = core.addDrainListener(() => this.#rearm());
    this.#rearm();
  }

  /** The deadline the timer is armed for, or undefined when the core waits on no time. */
  get armedDeadline(): number | undefined {
    return this.#armed?.deadline;
  }

  stop(): void {
    this.#removeDrainListener();
    this.#cancel();
  }

  #rearm(): void {
    if (this.#rearming) {
      return;
    }
    this.#rearming = true;
    try {
      this.#cancel();
      if (this.#core.destroyed) {
        return;
      }
      const answer = this.#core.nextDeadline();
      if (answer.status === Status.Ok && answer.value !== undefined) {
        this.#arm(answer.value);
      }
    } finally {
      this.#rearming = false;
    }
  }

  #arm(deadline: number): void {
    const delay = Math.min(Math.max(deadline - this.#clock.now(), 0), LONGEST_DELAY_MILLISECONDS);
    this.#armed = { deadline, token: this.#scheduler.schedule(() => this.#fire(), delay) };
  }

  #cancel(): void {
    if (this.#armed !== undefined) {
      this.#scheduler.cancel(this.#armed.token);
      this.#armed = undefined;
    }
  }

  #fire(): void {
    this.#armed = undefined;
    if (this.#core.destroyed) {
      return;
    }
    try {
      this.#core.advance(this.#clock.now());
    } catch (error) {
      this.#core.reportListenerError(error);
    }
  }
}
