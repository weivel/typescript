/** setTimeout's longest delay; a longer wait is made of several. */
const longestTimeout = 2 ** 31 - 1;

/** A run's stop request, read from an AbortSignal: once it aborts, it stays requested. */
export class StopRequest {
  readonly #signal: AbortSignal | undefined;
  readonly #arrived: Promise<void>;
  #stopListening: () => void = () => {};

  constructor(signal?: AbortSignal) {
    this.#signal = signal;
    this.#arrived = new Promise((resolve) => {
      if (signal === undefined) {
        return;
      }
      if (signal.aborted) {
        resolve();
        return;
      }
      const listener = (): void => resolve();
      signal.addEventListener("abort", listener, { once: true });
      this.#stopListening = () => signal.removeEventListener("abort", listener);
    });
  }

  get requested(): boolean {
    return this.#signal?.aborted === true;
  }

  /** Settles once the stop is requested; never, for a run given no signal. */
  arrived(): Promise<void> {
    return this.#arrived;
  }

  /** Waits until `clock` reads `at` or later, reading it again after every wait, or until the stop is requested. */
  async until(at: number, clock: () => number = Date.now): Promise<void> {
    for (let now = clock(); now < at && !this.requested; now = clock()) {
      await this.#sleep(Math.min(at - now, longestTimeout));
    }
  }

  #sleep(milliseconds: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slept = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, milliseconds);
    });
    return Promise.race([slept, this.#arrived]).finally(() => clearTimeout(timer));
  }

  /** Stops listening to the signal. */
  dispose(): void {
    this.#stopListening();
  }
}
