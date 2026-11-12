import { createHost, pluginError } from "../../engine/index.js";
import type { DeclarationRefusal, Host, PluginRuntime } from "../../engine/index.js";
import type { ManifestCapabilities, PluginContext, PluginManifest } from "../../index.js";
import { ManualScheduler } from "../manual-scheduler.js";
import type { Operation } from "../operation.js";

const SILENT: PluginRuntime = {
  config: { all: () => ({}), get: () => undefined, set: async () => {} },
  log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  paths: { cache: "", config: "", home: "", plugin: "", repos: "" },
  events: { publish: () => {}, subscribe: () => () => {} },
};

/** What a `provide` step hands the engine: an object naming its provider, so an answer is read off what the engine returned. */
interface Implementation {
  readonly provider: string;
}

interface Opened {
  readonly manifest: PluginManifest;
  readonly context: PluginContext;
}

interface Run {
  readonly host: Host;
  readonly diagnostics: string[];
  readonly outcomes: string[][];
  readonly heard: Array<Array<[string, string]>>;
  refusal: { message: string } | null;
}

/**
 * @implNote The driver goes through a host, never the registry, because the fence and the verified
 * boundary both live there. `reported` is read from the ledger's structured capability refusals,
 * never from the diagnostic text, which only supplies `refusal`.
 */
export const consume: Operation = (given) => {
  const diagnostics: string[] = [];
  const host = createHost({ app: "", applications: [], scheduler: new ManualScheduler(), diagnostics: (line) => diagnostics.push(line) });
  const opened = new Map<string, Opened>();
  for (const plugin of recordsOf(given.plugins)) {
    const manifest = manifestOf(plugin);
    opened.set(manifest.id, { manifest, context: host.contextFor(manifest, SILENT) });
  }
  const run: Run = { host, diagnostics, outcomes: [], heard: [], refusal: null };
  for (const step of recordsOf(given.steps)) {
    const pluginId = String(step.plugin);
    const plugin = opened.get(pluginId);
    if (plugin === undefined) throw new Error(`step names plugin '${pluginId}', which the vector does not declare`);
    perform(run, pluginId, plugin, step);
  }
  return {
    outcomes: run.outcomes,
    heard: run.heard,
    reported: capabilityRefusals(host).map((refusal) => [refusal.pluginId, refusal.id]),
    refusal: run.refusal,
  };
};

function perform(run: Run, pluginId: string, { manifest, context }: Opened, step: Record<string, unknown>): void {
  if (typeof step.provide === "string") {
    const implementation: Implementation = { provider: pluginId };
    context.provide(context.capability<Implementation>(step.provide), implementation);
  } else if (step.verify === true) {
    const refusal = run.host.verifyActivation(manifest);
    if (refusal !== null) run.host.markBroken(pluginId, refusal);
  } else if (step.quarantine === true) {
    run.host.markBroken(pluginId, pluginError(pluginId, "quarantined by the conformance driver", "none, the vector asked for it"));
  } else if (step.release === true) {
    run.host.release(pluginId);
  } else if (typeof step.all === "string") {
    const capabilityId = step.all;
    noticingRefusal(run, () => run.outcomes.push(context.capabilities.all(context.capability<Implementation>(capabilityId)).map((found) => found.provider)));
  } else if (typeof step.watch === "string") {
    const capabilityId = step.watch;
    const heard: Array<[string, string]> = [];
    run.heard.push(heard);
    noticingRefusal(run, () =>
      context.capabilities.watch(context.capability<Implementation>(capabilityId), (implementation, event) => {
        heard.push([implementation.provider, event]);
        if (step.throws === true) throw new Error("the conformance listener throws on every call");
      }),
    );
  } else {
    throw new Error(`unknown step ${JSON.stringify(step)}`);
  }
}

function noticingRefusal(run: Run, call: () => void): void {
  const emitted = run.diagnostics.length;
  call();
  const line = run.diagnostics[emitted];
  if (run.refusal === null && line !== undefined) run.refusal = { message: line };
}

function capabilityRefusals(host: Host): DeclarationRefusal[] {
  return host.ledger.refusals().filter((refusal) => refusal.kind === "capability");
}

function manifestOf(plugin: Record<string, unknown>): PluginManifest {
  const id = String(plugin.id);
  return { id, name: id, importName: id, api: 1, capabilities: plugin.capabilities as ManifestCapabilities };
}

function recordsOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null) : [];
}
