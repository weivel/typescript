/** Answers what the run shows for one `then` field, in the field's own terms. */
export type Observer = () => unknown;

function isEqualsMatcher(expectation: unknown): boolean {
  return (
    typeof expectation === "object" &&
    expectation !== null &&
    !Array.isArray(expectation) &&
    Object.keys(expectation).length === 1 &&
    "equals" in expectation
  );
}

/**
 * What the run shows for every field of `then`, in the vector's own shape: an `{ equals }` field is answered as
 * `{ equals: <observed> }`, any other field as the observed value, so the answer equals `then` exactly when the run
 * witnessed it.
 *
 * @throws Error for a field no observer answers: a field the driver does not know fails, never passes unread.
 */
export function observe(vectorId: string, then: Readonly<Record<string, unknown>>, observers: Readonly<Record<string, Observer>>): Record<string, unknown> {
  const observed: Record<string, unknown> = {};
  for (const [field, expectation] of Object.entries(then)) {
    const observer = observers[field];
    if (observer === undefined) {
      throw new Error(`The vector ${vectorId} states then.${field}, which this driver does not witness.`);
    }
    observed[field] = isEqualsMatcher(expectation) ? { equals: observer() } : observer();
  }
  return observed;
}

/** @throws Error naming the first key of `value` that `known` does not hold. */
export function refuseUnknownKeys(where: string, value: object, known: readonly string[]): void {
  const unknown = Object.keys(value).find((key) => !known.includes(key));
  if (unknown !== undefined) {
    throw new Error(`${where} carries ${unknown}, which this driver does not drive.`);
  }
}
