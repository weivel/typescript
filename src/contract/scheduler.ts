/**
 * The one clock a host supplies, from which every deadline in the system comes.
 *
 * @remarks
 * Cancelling is the returned disposer, which may be called more than once.
 */
export interface Scheduler {
  schedule(task: () => void, delayMillis: number): () => void;
}

/** A scheduler that runs nothing, for a host that wants no deadline to ever fire. */
export const NEVER: Scheduler = {
  schedule: () => () => {},
};
