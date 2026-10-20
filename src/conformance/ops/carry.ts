import { createHost, factsOf } from "../../engine/index.js";
import type { PluginRuntime } from "../../engine/index.js";
import type { PluginManifest } from "../../index.js";
import type { Operation } from "../operation.js";

const SILENT: PluginRuntime = {
  config: { all: () => ({}), get: () => undefined, set: async () => {} },
  log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  paths: { cache: "", config: "", home: "", plugin: "", repos: "" },
  events: { publish: () => {}, subscribe: () => () => {} },
};

/**
 * @implNote The vector's manifest is handed to `contextFor` as it was parsed, and is never
 * validated or rebuilt first: invariant 5 says an unknown field is carried, and the question is
 * whether this very object comes back.
 */
export const carry: Operation = (given) => {
  const manifest = given.manifest;
  if (!isManifest(manifest)) return { sameObject: false };
  const context = createHost({ app: "", applications: [], api: factsOf(manifest).api }).contextFor(manifest, SILENT);
  return { sameObject: context.manifest === manifest };
};

function isManifest(value: unknown): value is PluginManifest {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "id") === "string";
}
