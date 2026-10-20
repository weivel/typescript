export type * from "./contract/model.js";
export type * from "./contract/product.js";
export type { PluginError } from "./contract/error.js";
export type { Scheduler } from "./contract/scheduler.js";
export { NEVER } from "./contract/scheduler.js";

/** The API major version this package implements. */
export const API_VERSION: number = 2;
