import type { Operations } from "./operation.js";
import { answer } from "./ops/answer.js";
import { boot } from "./ops/boot.js";
import { carry } from "./ops/carry.js";
import { context } from "./ops/context.js";
import { identity } from "./ops/identity.js";
import { order } from "./ops/order.js";
import { reach } from "./ops/reach.js";
import { resolve } from "./ops/resolve.js";
import { revoke } from "./ops/revoke.js";
import { scope } from "./ops/scope.js";
import { supports } from "./ops/supports.js";
import { unbound } from "./ops/unbound.js";
import { validate } from "./ops/validate.js";
import { want } from "./ops/want.js";

/** The ops this driver can witness; an op absent here answers unwitnessed. */
export const operations: Operations = { answer, boot, carry, context, identity, order, reach, resolve, revoke, scope, supports, unbound, validate, want };
