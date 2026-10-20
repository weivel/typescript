/**
 * A refusal, recognised by its `name` marker and never by type identity, so one minted in another
 * realm or implementation is still recognised.
 */
export interface PluginError extends Error {
  readonly name: "PluginError";
  readonly pluginId: string;
  readonly detail: string;
  readonly fix: string;
}
