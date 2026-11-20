/**
 * An opaque object a described operation answered, which lives until its `release()`, its library's unload, or, when
 * it was got through a definition an answer carried, the release of that answer.
 */
export interface DescribedHandle {
  /** Frees the handle through the release its description names; a later call, or one after the unload, does nothing. */
  release(): void;
}

interface HandleState {
  readonly pointer: object | null;
  /** The opaque type of a handle, or null for an answer kept alive, which no operation takes back. */
  readonly type: string | null;
  /** The library whose definitions take the handle back, which every holdings of that library shares. */
  readonly library: object;
  readonly free: (pointer: object | null) => void;
  live: boolean;
}

const states = new WeakMap<DescribedHandle, HandleState>();

/**
 * Every handle one library's definitions answered, and every answer kept alive for a definition it carried, that
 * nobody has released yet, so its unload releases each of them while its binary is still open. What was got through a
 * definition an answer carried is held by a child, which the release of that answer releases; a handle any of them
 * holds is taken back by every definition of the same library.
 */
export class HandleHoldings {
  readonly #live = new Set<HandleState>();

  /** @param library what every holdings of one library shares, so a handle any of them answered is taken by all. */
  constructor(readonly library: object = {}) {}

  /** Holdings of the same library whose release releases only what they hold. */
  child(): HandleHoldings {
    return new HandleHoldings(this.library);
  }

  /** Wraps `pointer`, of the opaque `type`, which `free` releases. */
  hold(pointer: object, type: string, free: (pointer: object) => void): DescribedHandle {
    return this.#held(pointer, type, (held) => free(held!));
  }

  /** Keeps an answer alive until its release, which `free` performs; no operation takes it back as a handle. */
  keep(free: () => void): DescribedHandle {
    return this.#held(null, null, free);
  }

  #held(pointer: object | null, type: string | null, free: (pointer: object | null) => void): DescribedHandle {
    const state: HandleState = { pointer, type, library: this.library, free, live: true };
    const handle: DescribedHandle = Object.freeze({ release: () => this.#release(state) });
    states.set(handle, state);
    this.#live.add(state);
    return handle;
  }

  /**
   * The pointer `handle` stands for, to hand a definition of this library, whichever of its holdings holds it.
   *
   * @throws TypeError for anything but a live handle of `type` that this library answered.
   */
  pointerOf(handle: unknown, type: string, where: string): object {
    const state = typeof handle === "object" && handle !== null ? states.get(handle as DescribedHandle) : undefined;
    if (state === undefined || state.library !== this.library || state.type === null) {
      throw new TypeError(`${where} takes a handle this library answered.`);
    }
    if (state.type !== type) {
      throw new TypeError(`${where} takes a ${type}, and the handle it was handed is a ${state.type}.`);
    }
    if (!state.live) {
      throw new TypeError(`${where} was handed a handle that has been released.`);
    }
    return state.pointer!;
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
