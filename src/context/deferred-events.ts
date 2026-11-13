import type { CoreEvent } from "../core/index.js";

/**
 * Holds the core's events while a call this layer made has not yet recorded its answer, then handles them in the
 * order the core queued them.
 *
 * @remarks The core wrapper dispatches a call's events before the call returns, so a want settled by the call that
 * registered its service would otherwise arrive before the layer knows which object that registration stands for.
 */
export class DeferredEvents {
  readonly #handle: (event: CoreEvent) => void;
  readonly #report: (error: unknown, event: CoreEvent) => void;
  readonly #whenIdle: () => void;
  readonly #queue: CoreEvent[] = [];
  #callDepth = 0;
  #handling = false;

  constructor(handle: (event: CoreEvent) => void, report: (error: unknown, event: CoreEvent) => void, whenIdle: () => void) {
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

  #handleOne(event: CoreEvent): void {
    try {
      this.#handle(event);
    } catch (error) {
      this.#report(error, event);
    }
  }
}
