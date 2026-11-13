import type { CoreEvent } from "../core/index.js";

/**
 * Holds the core's events while a call this layer made has not yet recorded its answer, then handles them in the
 * order the core queued them.
 *
 * @remarks The core wrapper dispatches a call's events before the call returns, so a want settled by the call that
 * registered its service would otherwise arrive before the layer knows which object that registration stands for.
 */
/** A step queued among the events to handle, run when the handling reaches it. */
class DeferredStep {
  constructor(readonly step: () => void) {}
}

export class DeferredEvents {
  readonly #handle: (event: CoreEvent) => void;
  readonly #report: (error: unknown, event: CoreEvent | undefined) => void;
  readonly #whenIdle: () => void;
  readonly #queue: (CoreEvent | DeferredStep)[] = [];
  #callDepth = 0;
  #handling = false;

  constructor(handle: (event: CoreEvent) => void, report: (error: unknown, event: CoreEvent | undefined) => void, whenIdle: () => void) {
    this.#handle = handle;
    this.#report = report;
    this.#whenIdle = whenIdle;
  }

  /**
   * True when no call of this layer is in progress, no event waits here, and none is being handled.
   *
   * @remarks While an event is handled the core may still be dispatching, so events it queued before a call made
   * from a handler may not have reached this queue yet.
   */
  get idle(): boolean {
    return this.#callDepth === 0 && !this.#handling && this.#queue.length === 0;
  }

  receive(event: CoreEvent): void {
    this.#queue.push(event);
    if (this.#callDepth === 0) {
      this.#handleQueued();
    }
  }

  /** Runs `step` once every event received so far has been handled: at once when idle, else queued behind them. */
  whenHandled(step: () => void): void {
    this.#queue.push(new DeferredStep(step));
    if (this.#callDepth === 0) {
      this.#handleQueued();
    }
  }

  /** Makes a call and records its answer before any event it caused is handled. */
  around<Value>(callAndRecord: () => Value): Value {
    this.#callDepth += 1;
    try {
      return callAndRecord();
    } finally {
      this.#callDepth -= 1;
      if (this.#callDepth === 0) {
        this.#handleQueued();
        if (this.idle) {
          this.#whenIdle();
        }
      }
    }
  }

  #handleQueued(): void {
    if (this.#handling) {
      return;
    }
    this.#handling = true;
    try {
      for (let event = this.#queue.shift(); event !== undefined; event = this.#queue.shift()) {
        this.#handleOne(event);
      }
    } finally {
      this.#handling = false;
    }
  }

  #handleOne(next: CoreEvent | DeferredStep): void {
    try {
      if (next instanceof DeferredStep) {
        next.step();
      } else {
        this.#handle(next);
      }
    } catch (error) {
      this.#report(error, next instanceof DeferredStep ? undefined : next);
    }
  }
}
