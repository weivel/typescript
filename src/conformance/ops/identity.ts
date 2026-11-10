import { isIdentityId } from "../../engine/identity.js";
import type { Operation } from "../operation.js";

export const identity: Operation = (given) => ({ valid: typeof given.value === "string" && isIdentityId(given.value) });
