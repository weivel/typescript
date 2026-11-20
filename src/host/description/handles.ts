/** An opaque object a described operation answered, which lives until its `release()` or its library's unload. */
export interface DescribedHandle {
  /** Frees the handle through the release its description names; a later call, or one after the unload, does nothing. */
  release(): void;
}

interface HandleState {
  readonly pointer: object;
  readonly type: string;
  readonly holdings: HandleHoldings;
  readonly free: (pointer: object) => void;
  live: boolean;
}

const states = new WeakMap<DescribedHandle, HandleState>();

/**
 * Every handle one library's definitions answered and nobody has released yet, so its unload releases each of them
 * while its binary is still open.
 */
export class HandleHoldings {
  readonly #live = new Set<HandleState>();

  /** Wraps `pointer`, of the opaque `type`, which `free` releases. */
  hold(pointer: object, type: string, free: (pointer: object) => void): DescribedHandle {
    const state: HandleState = { pointer, type, holdings: this, free, live: true };
    const handle: DescribedHandle = Object.freeze({ release: () => this.#release(state) });
    states.set(handle, state);
    this.#live.add(state);
    return handle;
  }

  /**
   * The pointer `handle` stands for, to hand a definition of this library.
   *
   * @throws TypeError for anything but a live handle of `type` that this library answered.
   */
  pointerOf(handle: unknown, type: string, where: string): object {
    const state = typeof handle === "object" && handle !== null ? states.get(handle as DescribedHandle) : undefined;
    if (state === undefined || state.holdings !== this) {
      throw new TypeError(`${where} takes a handle this library answered.`);
    }
    if (state.type !== type) {
      throw new TypeError(`${where} takes a ${type}, and the handle it was handed is a ${state.type}.`);
    }
    if (!state.live) {
      throw new TypeError(`${where} was handed a handle that has been released.`);
    }
    return state.pointer;
  }

  /** Releases every handle still held, in the order they were answered. */
  releaseAll(): void {
    for (const state of [...this.#live]) {
      this.#release(state);
    }
  }

  #release(state: HandleState): void {
    if (!state.live) {
      return;
    }
    state.live = false;
    this.#live.delete(state);
    state.free(state.pointer);
  }
}
