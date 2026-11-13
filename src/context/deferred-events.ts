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
  readonly #queue: CoreEvent[] = [];
  #callDepth = 0;
  #handling = false;

  constructor(handle: (event: CoreEvent) => void, report: (error: unknown, event: CoreEvent) => void) {
    this.#handle = handle;
    this.#report = report;
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
