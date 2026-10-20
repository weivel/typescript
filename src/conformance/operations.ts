import type { Operations } from "./operation.js";
import { boot } from "./ops/boot.js";
import { order } from "./ops/order.js";
import { supports } from "./ops/supports.js";
import { validate } from "./ops/validate.js";

/** The ops this driver can witness; an op absent here answers unwitnessed. */
export const operations: Operations = { boot, order, supports, validate };
