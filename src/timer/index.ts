import type { Core } from "../core/index.js";

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

/** Told of every move the timer makes: the deadline it armed, or undefined when it disarmed. */
export type TimerMoveListener = (deadline: number | undefined) => void;

export interface CoreTimerOptions {
  readonly clock?: Clock;
  readonly scheduler?: Scheduler;
  readonly onMove?: TimerMoveListener;
}

interface Armed {
  readonly deadline: number;
  readonly token: unknown;
}

/**
 * Keeps one timer armed for the core's next deadline, moved by each deadline announcement as the core wrapper drains
 * it, and on firing tells the core the time with weivel_advance.
 */
export class CoreTimer {
  readonly #core: Core;
  readonly #clock: Clock;
  readonly #scheduler: Scheduler;
  readonly #onMove: TimerMoveListener | undefined;
  #armed: Armed | undefined;

  constructor(core: Core, options: CoreTimerOptions = {}) {
    this.#core = core;
    this.#clock = options.clock ?? systemClock;
    this.#scheduler = options.scheduler ?? systemScheduler;
    this.#onMove = options.onMove;
    core.setDeadlineReader((deadline) => this.#move(deadline));
    core.setClock(() => this.#clock.now());
  }

  /** The deadline the timer is armed for, or undefined when the core waits on no time. */
  get armedDeadline(): number | undefined {
    return this.#armed?.deadline;
  }

  stop(): void {
    this.#core.setDeadlineReader(undefined);
    this.#core.setClock(undefined);
    this.#cancel();
  }

  #move(deadline: number | undefined): void {
    this.#cancel();
    if (deadline !== undefined) {
      this.#arm(deadline);
    }
    this.#onMove?.(deadline);
  }

  #arm(deadline: number): void {
    const delay = Math.min(Math.max(deadline - this.#clock.now(), 0), LONGEST_DELAY_MILLISECONDS);
    this.#armed = { deadline, token: this.#scheduler.schedule(() => this.#wake(deadline), delay) };
  }

  #cancel(): void {
    if (this.#armed !== undefined) {
      this.#scheduler.cancel(this.#armed.token);
      this.#armed = undefined;
    }
  }

  #wake(deadline: number): void {
    this.#armed = undefined;
    if (this.#clock.now() < deadline) {
      this.#arm(deadline);
      return;
    }
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
