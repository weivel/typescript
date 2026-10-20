import type { PluginError } from "../index.js";

/**
 * Mints the one host-visible plugin failure.
 *
 * @remarks
 * The message names the plugin, what went wrong and what to do about it, because a load failure is
 * read by an author who has never seen this code.
 */
export function pluginError(pluginId: string, detail: string, fix: string): PluginError {
  const failure = new Error(`[${pluginId}] ${detail}\n  fix: ${fix}`);
  return Object.assign(failure, { name: "PluginError" as const, pluginId, detail, fix });
}

/**
 * @implNote Recognised by the `name` marker and never by `instanceof`, so a refusal minted by
 * another copy of this module or another realm is still recognised.
 */
export function isPluginError(value: unknown): value is PluginError {
  return value instanceof Error && value.name === "PluginError";
}
