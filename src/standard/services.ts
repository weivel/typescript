/**
 * A setting's value, one of the kinds `services.h` publishes: text, a finite number, or a boolean.
 *
 * @implNote services.h's kind NONE is never a value to store; here it is `undefined`, which `get` answers for a key
 * neither stored nor defaulted and which `set` does not take.
 */
export type SettingValue = string | number | boolean;

/** Why a provider declined an operation, as services.h's `weivel_standard_service_refusal` carries it. */
export class ServiceRefusal extends Error {
  readonly detail: string;
  readonly fix: string;

  constructor(detail: string, fix: string) {
    super(detail);
    this.name = "ServiceRefusal";
    this.detail = detail;
    this.fix = fix;
  }
}

/**
 * The settings a host reads, served under the standard's config service id, as `weivel_standard_config` defines them.
 * An operation the provider declines rejects with a ServiceRefusal; one handed what is not a value, such as a number
 * that is not finite, rejects with a TypeError and changes nothing.
 *
 * @implNote Every operation answers a promise, as services.h asks of a language whose interface is asynchronous, so a
 * provider in another process answers once the write has reached it. Nothing is released: an answer is a value the
 * garbage collector frees, which is all services.h's per-kind releases do.
 */
export interface Config {
  /** Every setting, the provider's defaults merged with what the host stores, each key once. */
  all(): Promise<Readonly<Record<string, SettingValue>>>;
  /** One setting, undefined when the key is neither stored nor defaulted. */
  get(key: string): Promise<SettingValue | undefined>;
  /** Stores one setting, replacing any value it had, so `get` and `all` answer it from then on. */
  set(key: string, value: SettingValue): Promise<void>;
}

/**
 * The secrets a host keeps, served under the standard's secrets service id, as `weivel_standard_secrets` defines
 * them: any bytes, so a secret that is text is stored as its UTF-8.
 *
 * @implNote Promises and no releases, as for Config.
 */
export interface Secrets {
  /** Removes one secret; removing one that is not there succeeds. */
  remove(name: string): Promise<void>;
  /** One secret, undefined when the name holds none. */
  get(name: string): Promise<Uint8Array | undefined>;
  /** Stores one secret, replacing any value it had. */
  set(name: string, bytes: Uint8Array): Promise<void>;
}

/**
 * The absolute directories a host stores files in, served under the standard's paths service id, as
 * `weivel_standard_paths` defines them. Each answers the same path on every call; whether it exists yet is not
 * promised.
 *
 * @implNote Promises, as for Config; there is nothing to release.
 */
export interface Paths {
  /** Where files that can be rebuilt are kept. */
  cache(): Promise<string>;
  /** Where settings files are kept. */
  config(): Promise<string>;
  /** The directory the host offers as the plugin's own. */
  plugin(): Promise<string>;
}

type EveryOperationOf<Definition> = readonly (keyof Definition)[];

/** Each definition's operations, by the names services.h gives them, its releases left out. */
export const serviceOperations = {
  config: ["all", "get", "set"],
  secrets: ["remove", "get", "set"],
  paths: ["cache", "config", "plugin"],
} as const satisfies {
  readonly config: EveryOperationOf<Config>;
  readonly secrets: EveryOperationOf<Secrets>;
  readonly paths: EveryOperationOf<Paths>;
};
