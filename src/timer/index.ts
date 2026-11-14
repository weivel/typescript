import type { Core } from "../core/index.js";

/** The caller's monotonic time in whole milliseconds, the scale every time handed to the core is on. */
export interface Clock {
  now(): number;
}

/**
 * Runs the timer's callback when the clock reaches a time. A callback run early is harmless: the timer arms again.
 */
export interface Scheduler {
  /** Runs `callback` once when the clock reaches `at`, at once when it already has; answers a token `cancel` reads. */
  schedule(callback: () => void, at: number): unknown;
  cancel(token: unknown): void;
  /**
   * The longest the scheduler can wait, in milliseconds; absent when it can wait any time.
   *
   * @implNote Whether a wait ends short of the deadline is known only from the time now, so the timer reads the clock
   * once as it schedules on a scheduler that gives one, and never on one that does not.
   */
  readonly maximumWaitMilliseconds?: number;
}

export const systemClock: Clock = { now: () => Math.floor(performance.now()) };

/** setTimeout's largest delay; a later time is reached by waiting again when the shorter wait ends. */
const LONGEST_DELAY_MILLISECONDS = 2_147_483_647;

interface SystemTask {
  timeout: ReturnType<typeof setTimeout> | undefined;
}

function waitUntil(task: SystemTask, clock: Clock, at: number, callback: () => void): void {
  const remaining = at - clock.now();
  task.timeout =
    remaining > LONGEST_DELAY_MILLISECONDS
      ? setTimeout(() => waitUntil(task, clock, at, callback), LONGEST_DELAY_MILLISECONDS)
      : setTimeout(callback, Math.max(remaining, 0));
}

/**
 * A scheduler on `setTimeout` that can wait any time, reading `clock` to turn a time into a delay.
 *
 * @remarks Its timer is not unref'd, so a want waiting on time keeps Node alive until it settles.
 */
export function createSystemScheduler(clock: Clock = systemClock): Scheduler {
  return {
    schedule: (callback, at) => {
      const task: SystemTask = { timeout: undefined };
      waitUntil(task, clock, at, callback);
      return task;
    },
    cancel: (token) => clearTimeout((token as SystemTask).timeout),
  };
}

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
    this.#scheduler = options.scheduler ?? createSystemScheduler(this.#clock);
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
    this.#armed = { deadline, token: this.#scheduler.schedule(() => this.#wake(deadline), this.#waitEnd(deadline)) };
  }

  /** When the wait for `deadline` ends: the deadline itself, or sooner when the scheduler cannot wait that long. */
  #waitEnd(deadline: number): number {
    const longest = this.#scheduler.maximumWaitMilliseconds;
    return longest === undefined ? deadline : Math.min(deadline, this.#clock.now() + longest);
  }

  #cancel(): void {
    if (this.#armed !== undefined) {
      this.#scheduler.cancel(this.#armed.token);
      this.#armed = undefined;
    }
  }

  #wake(deadline: number): void {
    this.#armed = undefined;
    const now = this.#clock.now();
    if (now < deadline) {
      this.#arm(deadline);
      return;
    }
    if (this.#core.destroyed) {
      return;
    }
    try {
      this.#core.advance(now);
    } catch (error) {
      this.#core.reportListenerError(error);
    }
  }
}
