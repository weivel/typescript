function freezeDeeply<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(freezeDeeply);
    Object.freeze(value);
  }
  return value;
}

/** A copy of a plain value, every nested object and array its own and frozen, so no holder of the original reaches it. */
export function frozenCopyOf<Value>(value: Value): Value {
  return freezeDeeply(structuredClone(value));
}
