import type { Operations } from "./operation.js";
import { supports } from "./ops/supports.js";
import { validate } from "./ops/validate.js";

/** The ops this driver can witness; an op absent here answers unwitnessed. */
export const operations: Operations = { supports, validate };
