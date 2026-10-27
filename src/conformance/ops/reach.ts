import { createHost, isPluginError } from "../../engine/index.js";
import type { Host, PluginRuntime } from "../../engine/index.js";
import type { PluginContext, PluginManifest } from "../../index.js";
import { ManualScheduler } from "../manual-scheduler.js";
import type { Operation } from "../operation.js";
import { settledTurn, settlementOf } from "./settlement.js";
import type { Settlement } from "./settlement.js";

const SILENT: PluginRuntime = {
  config: { all: () => ({}), get: () => undefined, set: async () => {} },
  log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  paths: { cache: "", config: "", home: "", plugin: "", repos: "" },
  events: { publish: () => {}, subscribe: () => () => {} },
};

type Reach = "served" | "absent" | "refused";

type Refusal = { detail: string; fix: string } | { message: string };

/** What one step answers once the run is over, and the refusal text it produced, if any. */
interface StepAnswer {
  outcome(): Reach | string[];
  refusal(): Refusal | null;
}

/**
 * @implNote The driver goes through a host, never the hub, because the refusal lives in the fence
 * the host builds from each manifest. Whether a `get` or `watch` was refused is read from the
 * ledger's structured refusals, never from the diagnostic text, which only supplies `refusal`.
 */
export const reach: Operation = async (given) => {
  const diagnostics: string[] = [];
  const host = createHost({ app: "", applications: [], scheduler: new ManualScheduler(), diagnostics: (line) => diagnostics.push(line) });
  const contexts = new Map<string, PluginContext>();
  for (const plugin of recordsOf(given.plugins)) {
    const manifest = manifestOf(plugin);
    contexts.set(manifest.id, host.contextFor(manifest, SILENT));
  }
  for (const id of stringsOf(given.hostProvided)) host.provideService(id, { name: () => id });
  const answers: StepAnswer[] = [];
  for (const step of recordsOf(given.steps)) {
    const pluginId = String(step.plugin);
    const context = contexts.get(pluginId);
    if (context === undefined) throw new Error(`step names plugin '${pluginId}', which the vector does not declare`);
    const answer = run(host, pluginId, context, step, diagnostics);
    if (answer !== undefined) answers.push(answer);
  }
  await settledTurn();
  return {
    outcomes: answers.map((answer) => answer.outcome()),
    reported: host.ledger.refusals().map((refusal) => [refusal.pluginId, refusal.serviceId]),
    refusal: answers.map((answer) => answer.refusal()).find((refusal) => refusal !== null) ?? null,
  };
};

function run(host: Host, pluginId: string, context: PluginContext, step: Record<string, unknown>, diagnostics: string[]): StepAnswer | undefined {
  const reported = (serviceId: string): boolean =>
    host.ledger.refusals().some((refusal) => refusal.pluginId === pluginId && refusal.serviceId === serviceId);
  if (typeof step.register === "string") {
    const serviceId = step.register;
    context.services.register(context.service(serviceId), { name: () => serviceId });
    return undefined;
  }
  if (typeof step.get === "string") {
    const serviceId = step.get;
    const emitted = diagnostics.length;
    const found = context.services.get(context.service(serviceId));
    const outcome: Reach = found !== undefined ? "served" : reported(serviceId) ? "refused" : "absent";
    const refusal = messageOf(diagnostics[emitted]);
    return { outcome: () => outcome, refusal: () => refusal };
  }
  if (typeof step.want === "string") {
    let rejection: unknown;
    const asked = context.services.want(context.service(step.want));
    asked.catch((failure: unknown) => {
      rejection = failure;
    });
    const settlement: Settlement = settlementOf(asked);
    return { outcome: () => wantOutcome(settlement), refusal: () => (isPluginError(rejection) ? { detail: rejection.detail, fix: rejection.fix } : null) };
  }
  if (typeof step.watch === "string") {
    const serviceId = step.watch;
    const emitted = diagnostics.length;
    let heard = false;
    context.services.watch(context.service(serviceId), (_service, event) => {
      if (event === "register") heard = true;
    });
    const refusal = messageOf(diagnostics[emitted]);
    return { outcome: () => (heard ? "served" : reported(serviceId) ? "refused" : "absent"), refusal: () => refusal };
  }
  if (step.ids === true) {
    const listed = [...context.services.ids()].sort();
    return { outcome: () => listed, refusal: () => null };
  }
  throw new Error(`unknown step ${JSON.stringify(step)}`);
}

function wantOutcome(settlement: Settlement): Reach {
  if (settlement.state === "settled") return "served";
  return settlement.state === "rejected" ? "refused" : "absent";
}

function messageOf(line: string | undefined): Refusal | null {
  return line === undefined ? null : { message: line };
}

function manifestOf(plugin: Record<string, unknown>): PluginManifest {
  return { id: String(plugin.id), api: 1, services: { consumes: stringsOf(plugin.consumes), provides: stringsOf(plugin.provides) } };
}

function recordsOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null) : [];
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
