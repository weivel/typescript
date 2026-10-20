import { validateManifest } from "../../engine/index.js";
import type { Operation } from "../operation.js";

export const validate: Operation = (given) => {
  const wellKnown = Array.isArray(given.wellKnownServices) ? (given.wellKnownServices as string[]) : undefined;
  const issues = validateManifest(given.manifest, wellKnown);
  const [first] = issues;
  return {
    valid: issues.length === 0,
    paths: issues.map((issue) => issue.path),
    refusal: first === undefined ? null : { detail: first.message, fix: first.fix },
  };
};
