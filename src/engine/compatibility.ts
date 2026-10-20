import type { PluginError } from "../index.js";
import { pluginError } from "./errors.js";
import type { ManifestFacts } from "./facts.js";

export interface HostIdentity {
  applications: readonly string[];
  api: number;
}

export interface Incompatibility {
  refusal: PluginError;
  axis: "application" | "api";
}

/**
 * Null when the host can load the plugin, otherwise the first axis that refuses it.
 *
 * @remarks
 * The application is checked before the api floor, because a refusal citing the floor when the
 * artifact was built for another application sends the author to the wrong line. Empty on either
 * side means any application. Language is deliberately not an axis: a host of another language
 * reaches the plugin through the compatibility layer instead of refusing it.
 */
export function compatibility(host: HostIdentity, facts: ManifestFacts): Incompatibility | null {
  return applicationRefusal(host, facts) ?? apiRefusal(host, facts);
}

function applicationRefusal(host: HostIdentity, facts: ManifestFacts): Incompatibility | null {
  const { targets } = facts;
  const overlaps = targets.some((target) => host.applications.includes(target));
  if (targets.length === 0 || host.applications.length === 0 || overlaps) {
    return null;
  }
  const refusal = pluginError(
    facts.id,
    `is built for ${targets.join(", ")}, and this host hosts ${host.applications.join(", ")}`,
    `install it in ${targets[0]}, or add "${host.applications[0]}" to "targets" in plugin.json`,
  );
  return { refusal, axis: "application" };
}

function apiRefusal(host: HostIdentity, facts: ManifestFacts): Incompatibility | null {
  if (facts.api <= host.api) {
    return null;
  }
  const refusal = pluginError(
    facts.id,
    `needs api ${facts.api}, this host has api ${host.api}`,
    `update the app to a version that implements api ${facts.api} or later`,
  );
  return { refusal, axis: "api" };
}
