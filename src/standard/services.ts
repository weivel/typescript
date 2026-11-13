/** The settings a host reads, served under the standard's config service id. */
export interface Config {
  /** Every setting, defaults merged with what the host stores. */
  all(): Record<string, unknown>;
  /** One setting, absent when it is neither set nor defaulted. */
  get<Value>(key: string): Value | undefined;
  /**
   * Writes one setting.
   *
   * @remarks Asynchronous even where a host writes synchronously, so the seam survives a provider in another process.
   */
  set(key: string, value: unknown): Promise<void>;
}

/** The secrets a host keeps for the plugin asking, served under the standard's secrets service id. */
export interface Secrets {
  /** Removes one secret; removing one that is not there succeeds. */
  delete(name: string): Promise<void>;
  /** One secret, absent when it was never set. */
  get(name: string): Promise<string | undefined>;
  /** Stores one secret, replacing any value it had. */
  set(name: string, value: string): Promise<void>;
}

/** The absolute directories a host stores the asking plugin's files in, served under the standard's paths service id. */
export interface Paths {
  readonly cache: string;
  readonly config: string;
  /** The plugin's own directory. */
  readonly plugin: string;
}
