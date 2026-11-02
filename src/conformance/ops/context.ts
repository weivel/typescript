import { createHost, isPluginError } from "../../engine/index.js";
import type { PluginRuntime } from "../../engine/index.js";
import type { ConfigSetOptions, PluginConfig, PluginContext, PluginPaths, PluginSecrets } from "../../index.js";
import type { Operation } from "../operation.js";

interface Written {
  key: string;
  layer: string | null;
}

type Refusal = { detail: string; fix: string } | { message: string };

const MANIFEST = { id: "config-ledger", api: 2 };

const UNUSED_SECRETS: PluginSecrets = {
  get: async () => undefined,
  set: async () => {},
  delete: async () => {},
};

/**
 * @implNote The answer is read off the CONTEXT the engine built, never off the runtime the driver
 * handed it, because a member the engine dropped or invented is exactly what the op asks about.
 */
export const context: Operation = async (given) => {
  const host = recordOf(given.host);
  const write = recordOf(given.write);
  const written: Written[] = [];
  const pluginContext = createHost({ app: "", applications: [], api: MANIFEST.api }).contextFor(
    MANIFEST,
    runtimeFor(host, written),
  );
  const refusal = await refusalOf(writeThrough(pluginContext, write));
  return {
    portable: pluginContext.paths.portable ?? null,
    secrets: pluginContext.secrets !== undefined,
    written: written[0] ?? null,
    refusal,
  };
};

function runtimeFor(host: Record<string, unknown>, written: Written[]): PluginRuntime {
  const portable = typeof host.portable === "string" ? { portable: host.portable } : {};
  const paths: PluginPaths = { cache: "", config: "", home: "", plugin: "", repos: "", ...portable };
  const runtime: PluginRuntime = {
    config: recordingConfig(written),
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    paths,
    events: { publish: () => {}, subscribe: () => () => {} },
  };
  return host.secrets === true ? { ...runtime, secrets: UNUSED_SECRETS } : runtime;
}

function recordingConfig(written: Written[]): PluginConfig {
  function set(key: string, value: unknown): Promise<void>;
  function set(key: string, value: unknown, options: ConfigSetOptions): Promise<void>;
  async function set(key: string, _value: unknown, options?: ConfigSetOptions): Promise<void> {
    written.push({ key, layer: options?.layer ?? null });
  }
  return { all: () => ({}), get: () => undefined, set };
}

function writeThrough(pluginContext: PluginContext, write: Record<string, unknown>): Promise<void> {
  const key = String(write.key);
  const layer = write.layer;
  if (layer === "application" || layer === "portable") return pluginContext.config.set(key, write.value, { layer });
  return pluginContext.config.set(key, write.value);
}

async function refusalOf(writing: Promise<void>): Promise<Refusal | null> {
  try {
    await writing;
    return null;
  } catch (failure: unknown) {
    if (isPluginError(failure)) return { detail: failure.detail, fix: failure.fix };
    return { message: failure instanceof Error ? failure.message : String(failure) };
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
