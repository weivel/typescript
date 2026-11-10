import { unboundServices } from "../../engine/identity.js";
import type { PluginManifest } from "../../index.js";
import type { Operation } from "../operation.js";

export const unbound: Operation = (given) => ({ services: unboundServices(given.manifest as { services?: PluginManifest["services"] }) });
