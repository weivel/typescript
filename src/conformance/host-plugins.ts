import type { NativeValue } from "../host/index.js";

/** What one plugin of a `host` vector's `given.plugins` does: its activation's steps and the actions it offers. */
export interface HostVectorPlugin {
  readonly name: string;
  readonly activate?: readonly Readonly<Record<string, unknown>>[];
  readonly actions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** The ids every plugin of a `host` vector consumes. */
export const consumedServiceIds = ["weivel.config", "weivel.secrets", "weivel.paths", "weivel.log"] as const;

const stepKinds = ["log", "logSetting", "set", "absent", "throw"] as const;
const actionKinds = ["echo", "answer", "throw"] as const;

/** @throws Error for a step or an action of a kind this driver does not know, or one holding more than its kind. */
function refuseUnknown(plugin: HostVectorPlugin): void {
  for (const step of plugin.activate ?? []) {
    const keys = Object.keys(step);
    const kind = stepKinds.find((candidate) => keys.includes(candidate));
    const expected = kind === "set" ? ["set", "to"] : [kind];
    if (kind === undefined || keys.length !== expected.length || !expected.every((key) => keys.includes(key!))) {
      throw new Error(`${plugin.name}'s step ${JSON.stringify(step)} is of no kind this driver realises.`);
    }
  }
  for (const [name, action] of Object.entries(plugin.actions ?? {})) {
    const keys = Object.keys(action);
    if (keys.length > 1 || (keys.length === 1 && !actionKinds.includes(keys[0] as (typeof actionKinds)[number]))) {
      throw new Error(`${plugin.name}'s action ${name} ${JSON.stringify(action)} is of no kind this driver realises.`);
    }
  }
}

/**
 * The interpreter every generated entry carries: it realises LAYER.md's steps through the services the program offers
 * the plugin, each the definition `weivel.scope` answered, bound by its description.
 */
const entryRuntime = String.raw`
const infoLevel = 3;
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
  } else {
    throw new Error(step.throw);
  }
}

function actionOf(action) {
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

export default {
  async activate(context) {
    for (const step of steps) {
      await runStep(context, step);
    }
  },
  actions: Object.fromEntries(Object.entries(actions).map(([name, action]) => [name, actionOf(action)])),
};
`;

/**
 * The source of an ES module realising `plugin`: its default export is the plugin.
 *
 * @throws Error for a step or an action of a kind this driver does not know.
 */
export function hostVectorEntrySource(plugin: HostVectorPlugin): string {
  refuseUnknown(plugin);
  return [`const steps = ${JSON.stringify(plugin.activate ?? [])};`, `const actions = ${JSON.stringify(plugin.actions ?? {})};`, entryRuntime].join("\n");
}

/** The manifest of a `host` vector's plugin `name`, consuming every id the program may offer it. */
export function hostVectorManifest(name: string, entryFileName: string): Readonly<Record<string, NativeValue>> {
  return { api: 1, importName: name, entry: entryFileName, services: { consumes: [...consumedServiceIds] } };
}
