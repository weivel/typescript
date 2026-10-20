import { compatibility, factsOf } from "../../engine/index.js";
import type { HostIdentity } from "../../engine/index.js";
import type { Operation } from "../operation.js";

export const supports: Operation = (given) => {
  const incompatibility = compatibility(given.host as HostIdentity, factsOf(given.facts));
  if (incompatibility === null) {
    return { supported: true, refusal: null, axis: null };
  }
  const { detail, fix } = incompatibility.refusal;
  return { supported: false, refusal: { detail, fix }, axis: incompatibility.axis };
};
