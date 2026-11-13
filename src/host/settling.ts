/**
 * Runs `continuation` once `value` settles: at once, in the same step, when `value` is no promise, so a plugin whose
 * deactivate finishes at once is released in the very call that asked for it; otherwise once the promise settles,
 * either way.
 */
export function afterSettling<Answer>(value: unknown, continuation: () => Answer | Promise<Answer>): Promise<Answer> {
  if (isThenable(value)) {
    return Promise.resolve(value).then(continuation, continuation);
  }
  try {
    return Promise.resolve(continuation());
  } catch (error) {
    return Promise.reject(error);
  }
}

export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" || typeof value === "function") && value !== null && typeof (value as PromiseLike<unknown>).then === "function";
}

/** Calls `call`, answering what it returned, or a rejected promise of what it threw. */
export function settledCall(call: () => unknown): unknown {
  try {
    return call();
  } catch (error) {
    return Promise.reject(error);
  }
}
