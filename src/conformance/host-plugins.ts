import type { NativeValue } from "../host/index.js";

/** What one plugin of a `host` vector's `given.plugins` does: its activation's steps and the actions it offers. */
export interface HostVectorPlugin {
  readonly name: string;
  /** True when its manifest is not written, so the program cannot read it. */
  readonly unreadableManifest?: boolean;
  /** The ids its manifest consumes in place of `consumedServiceIds`. */
  readonly consumes?: readonly string[];
  readonly activate?: readonly Readonly<Record<string, unknown>>[];
  readonly actions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** The ids a plugin of a `host` vector consumes unless it carries `consumes`. */
export const consumedServiceIds = ["weivel.config", "weivel.secrets", "weivel.paths", "weivel.log"] as const;

const stepKinds = ["log", "logSetting", "set", "absent", "waitFor", "pause", "throw"] as const;
const actionKinds = ["echo", "answer", "throw"] as const;
const longestPauseMillis = 10_000;

function isStepOfItsKind(step: Readonly<Record<string, unknown>>): boolean {
  const keys = Object.keys(step);
  const kind = stepKinds.find((candidate) => keys.includes(candidate));
  const expected = kind === "set" ? ["set", "to"] : [kind];
  if (kind === undefined || keys.length !== expected.length || !expected.every((key) => keys.includes(key!))) {
    return false;
  }
  if (kind === "waitFor") {
    return typeof step.waitFor === "string" && step.waitFor !== "";
  }
  if (kind === "pause") {
    return Number.isInteger(step.pause) && (step.pause as number) >= 1 && (step.pause as number) <= longestPauseMillis;
  }
  return true;
}

function isActionOfItsKind(action: Readonly<Record<string, unknown>>): boolean {
  const kinds = Object.keys(action).filter((key) => key !== "steps");
  const steps = action.steps;
  if (steps !== undefined && !(Array.isArray(steps) && steps.every((step) => typeof step === "object" && step !== null && isStepOfItsKind(step)))) {
    return false;
  }
  return kinds.length === 0 || (kinds.length === 1 && actionKinds.includes(kinds[0] as (typeof actionKinds)[number]));
}

/** @throws Error for a step or an action of a kind this driver does not know, or one holding more than its kind. */
function refuseUnknown(plugin: HostVectorPlugin): void {
  for (const step of plugin.activate ?? []) {
    if (!isStepOfItsKind(step)) {
      throw new Error(`${plugin.name}'s step ${JSON.stringify(step)} is of no kind this driver realises.`);
    }
  }
  for (const [name, action] of Object.entries(plugin.actions ?? {})) {
    if (!isActionOfItsKind(action)) {
      throw new Error(`${plugin.name}'s action ${name} ${JSON.stringify(action)} is of no kind this driver realises.`);
    }
  }
}

/**
 * The interpreter every generated entry carries: it realises LAYER.md's steps through the services the program offers
 * the plugin, each the definition `weivel.scope` answered, bound by its description.
 */
const entryRuntime = String.raw`
import { existsSync } from "node:fs";
import { join } from "node:path";

const infoLevel = 3;
const pollMillis = 5;
let activeContext;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(fileName) {
  const path = join(runDirectory, fileName);
  const startedAt = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - startedAt > boundMillis) {
      throw new Error(fileName + " did not appear within " + boundMillis + " ms");
    }
    await sleep(pollMillis);
  }
}

const settingKind = { text: 1, number: 2, boolean: 3 };

function service(context, id) {
  return context.services.get(context.service(id));
}

function settingText(answer) {
  if (typeof answer === "symbol" || answer.value.kind === 0) {
    return "none";
  }
  const value = answer.value;
  if (value.kind === settingKind.text) {
    return value.text ?? "";
  }
  if (value.kind === settingKind.number) {
    return String(value.number);
  }
  return value.boolean === 1 ? "true" : "false";
}

function settingOf(value) {
  if (typeof value === "string") {
    return { kind: settingKind.text, text: value, text_length: new TextEncoder().encode(value).length };
  }
  if (typeof value === "number") {
    return { kind: settingKind.number, number: value };
  }
  return { kind: settingKind.boolean, boolean: value ? 1 : 0 };
}

async function info(context, message) {
  await service(context, "weivel.log").write({ level: infoLevel, message });
}

async function runStep(context, step) {
  if ("log" in step) {
    await info(context, step.log);
  } else if ("logSetting" in step) {
    const answer = await service(context, "weivel.config").get({ key: step.logSetting });
    await info(context, step.logSetting + "=" + settingText(answer));
  } else if ("set" in step) {
    await service(context, "weivel.config").set({ key: step.set, value: settingOf(step.to) });
  } else if ("absent" in step) {
    if (service(context, step.absent) !== undefined) {
      throw new Error(step.absent + " answered this plugin something");
    }
  } else if ("waitFor" in step) {
    await waitFor(step.waitFor);
  } else if ("pause" in step) {
    await sleep(step.pause);
  } else {
    throw new Error(step.throw);
  }
}

function answerOf(action) {
  if ("echo" in action) {
    return (actionArguments) => actionArguments;
  }
  if ("answer" in action) {
    return () => action.answer;
  }
  if ("throw" in action) {
    return () => {
      throw new Error(action.throw);
    };
  }
  return () => undefined;
}

function actionOf(action) {
  const answer = answerOf(action);
  return async (actionArguments) => {
    for (const step of action.steps ?? []) {
      await runStep(activeContext, step);
    }
    return answer(actionArguments);
  };
}

export default {
  async activate(context) {
    activeContext = context;
    for (const step of steps) {
      await runStep(context, step);
    }
  },
  actions: Object.fromEntries(Object.entries(actions).map(([name, action]) => [name, actionOf(action)])),
};
`;

/**
 * The source of an ES module realising `plugin`: its default export is the plugin. A `waitFor` step waits for its file
 * in `runDirectory`, for up to `boundMillis`.
 *
 * @throws Error for a step or an action of a kind this driver does not know.
 */
export function hostVectorEntrySource(plugin: HostVectorPlugin, runDirectory: string, boundMillis: number): string {
  refuseUnknown(plugin);
  return [
    `const runDirectory = ${JSON.stringify(runDirectory)};`,
    `const boundMillis = ${JSON.stringify(boundMillis)};`,
    `const steps = ${JSON.stringify(plugin.activate ?? [])};`,
    `const actions = ${JSON.stringify(plugin.actions ?? {})};`,
    entryRuntime,
  ].join("\n");
}

/** The manifest of a `host` vector's plugin `name`, consuming `consumes`, every id the program may offer it by default. */
export function hostVectorManifest(
  name: string,
  entryFileName: string,
  consumes: readonly string[] = consumedServiceIds,
): Readonly<Record<string, NativeValue>> {
  return { api: 1, importName: name, entry: entryFileName, services: { consumes: [...consumes] } };
}
