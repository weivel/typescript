import { EdgeSource, PluginStatus, type Manifest } from "../core/index.js";
import { RefusalError, type PluginContext } from "../context/index.js";
import type { Plugin } from "../host/index.js";
import { refuseUnknownKeys, type Observer } from "./expectations.js";
import { kitCodeName } from "./refusals.js";
import type { LayerVector } from "./vectors.js";
import { alive, settled, type BuiltPlugin, type DriverWorld } from "./world.js";

type Action = { readonly register: string } | { readonly want: string; readonly await?: boolean } | { readonly get: string };

interface GivenPlugin {
  readonly id: string;
  readonly provides: readonly string[];
  readonly consumes: readonly string[];
  readonly activate: readonly Action[];
  readonly deactivate?: readonly Action[];
}

type Step =
  | { readonly activate: readonly string[] }
  | { readonly release: string }
  | { readonly destroy: true }
  | { readonly verify: string }
  | { readonly plugin: string; readonly get: string };

interface LifecycleGiven {
  readonly edgeSource: string;
  readonly plugins: readonly GivenPlugin[];
  readonly steps: readonly Step[];
}

const edgeSources: Readonly<Record<string, EdgeSource>> = { capabilities: EdgeSource.Capabilities, services: EdgeSource.Services };
const actionKeys = ["register", "want", "get"] as const;
const stepKeys = ["activate", "release", "destroy", "verify", "get"] as const;

function checkAction(where: string, action: Action): void {
  const named = actionKeys.filter((key) => key in action);
  if (named.length !== 1) {
    throw new Error(`${where} names ${named.length} actions; an action names exactly one of ${actionKeys.join(", ")}.`);
  }
  refuseUnknownKeys(where, action, named[0] === "want" ? ["want", "await"] : [named[0]!]);
}

function checkPlugin(vectorId: string, plugin: GivenPlugin): void {
  const where = `The vector ${vectorId}'s plugin ${plugin.id}`;
  refuseUnknownKeys(where, plugin, ["id", "provides", "consumes", "activate", "deactivate"]);
  plugin.activate.forEach((action, index) => checkAction(`${where}'s activate action ${index}`, action));
  plugin.deactivate?.forEach((action, index) => checkAction(`${where}'s deactivate action ${index}`, action));
}

function checkStep(vectorId: string, step: Step, index: number): void {
  const where = `The vector ${vectorId}'s step ${index}`;
  const named = stepKeys.filter((key) => key in step);
  if (named.length !== 1) {
    throw new Error(`${where} names ${named.length} actions; a step names exactly one of ${stepKeys.join(", ")}.`);
  }
  refuseUnknownKeys(where, step, named[0] === "get" ? ["plugin", "get"] : [named[0]!]);
}

function checkGiven(vector: LayerVector): LifecycleGiven {
  refuseUnknownKeys(`The vector ${vector.id}'s given`, vector.given, ["edgeSource", "plugins", "steps"]);
  const given = vector.given as unknown as LifecycleGiven;
  if (edgeSources[given.edgeSource] === undefined) {
    throw new Error(`The vector ${vector.id} names the edge source ${given.edgeSource}, which this driver does not know.`);
  }
  given.plugins.forEach((plugin) => checkPlugin(vector.id, plugin));
  given.steps.forEach((step, index) => checkStep(vector.id, step, index));
  return given;
}

/** The edge source a lifecycle vector's host activates with. */
export function lifecycleEdgeSource(vector: LayerVector): EdgeSource {
  return edgeSources[checkGiven(vector).edgeSource]!;
}

/** A given plugin's manifest: its service ids exactly as written, and an entry named when it provides one. */
function manifestOf(plugin: GivenPlugin): Manifest {
  return {
    importName: plugin.id,
    api: 1,
    services: { provides: plugin.provides.map((id) => ({ id })), consumes: plugin.consumes.map((id) => ({ id })) },
    ...(plugin.provides.length > 0 ? { entry: `${plugin.id}.ts` } : {}),
  };
}

/** The objects a plugin registers: the kit names a registration by its provider. */
interface Registered {
  readonly provider: string;
}

class LifecycleRun {
  readonly trace: string[] = [];
  readonly plans: string[][] = [];
  readonly verifies: string[] = [];
  readonly #pending = new Set<string>();
  readonly #contexts = new Map<string, PluginContext>();
  #loud = 0;
  #destroying = false;
  #loudFrom = 0;

  constructor(readonly world: DriverWorld) {}

  built(plugin: GivenPlugin): BuiltPlugin {
    return { manifest: manifestOf(plugin), entry: this.#entryOf(plugin) };
  }

  #entryOf(plugin: GivenPlugin): Plugin {
    const deactivate = plugin.deactivate;
    return {
      activate: (context) => {
        this.trace.push(`activate ${plugin.id}`);
        this.#contexts.set(plugin.id, context);
        return this.#runActions(plugin.id, context, plugin.activate, 0);
      },
      ...(deactivate === undefined
        ? {}
        : {
            deactivate: () => {
              this.trace.push(`deactivate ${plugin.id}`);
              return this.#runActions(plugin.id, this.#contextOf(plugin.id), deactivate, 0);
            },
          }),
    };
  }

  /** Runs `actions` from `index` on, answering a promise only once an action has to wait for a want to end. */
  #runActions(name: string, context: PluginContext, actions: readonly Action[], index: number): void | Promise<void> {
    for (let next = index; next < actions.length; next += 1) {
      const action = actions[next]!;
      if ("register" in action) {
        context.services.register(context.service<Registered>(action.register), { provider: name });
        this.trace.push(`registered ${name} ${action.register}`);
      } else if ("want" in action) {
        const ended = this.#want(name, context, action.want);
        if (action.await !== false) {
          return ended.then(() => this.#runActions(name, context, actions, next + 1));
        }
      } else {
        this.#get(name, context, action.get);
      }
    }
    return undefined;
  }

  #want(name: string, context: PluginContext, id: string): Promise<void> {
    const pending = `${name} ${id}`;
    this.#pending.add(pending);
    return context.services.want(context.service(id)).then(
      () => {
        this.#pending.delete(pending);
        this.trace.push(`settled ${name} ${id}`);
      },
      (error: unknown) => {
        this.#pending.delete(pending);
        this.trace.push(`rejected ${name} ${id} ${error instanceof RefusalError ? kitCodeName(error.code) : String(error)}`);
      },
    );
  }

  #get(name: string, context: PluginContext, id: string): void {
    const served = context.services.get(context.service(id)) !== undefined;
    this.trace.push(`${served ? "got" : "missed"} ${name} ${id}`);
  }

  #contextOf(name: string): PluginContext {
    const context = this.#contexts.get(name);
    if (context === undefined) {
      throw new Error(`A step names ${name}, whose activate was never called.`);
    }
    return context;
  }

  async run(step: Step): Promise<void> {
    try {
      await this.#perform(step);
    } catch (error) {
      if (this.#destroying) {
        this.#loud += 1;
        return;
      }
      throw error;
    }
    await settled();
  }

  async #perform(step: Step): Promise<void> {
    if ("activate" in step) {
      const started = alive(this.world.host.activate(step.activate.map((name) => this.world.plugin(name))));
      this.plans.push(started.plan.order.map((plugin) => this.#nameOf(plugin)));
    } else if ("release" in step) {
      await this.world.host.release(this.world.plugin(step.release));
    } else if ("destroy" in step) {
      this.#destroying = true;
      this.#loudFrom = this.#loudSoFar();
      await this.world.host.destroy();
    } else if ("verify" in step) {
      this.#verify(step.verify);
    } else {
      this.#get(step.plugin, this.#contextOf(step.plugin), step.get);
    }
  }

  /** Errors the layer has written to its log or its error sink so far. */
  #loudSoFar(): number {
    return this.world.logs.filter((entry) => entry.level === "error").length + this.world.sunk.length;
  }

  #verify(name: string): void {
    const written = this.world.logs.length + this.world.sunk.length;
    try {
      this.world.host.verify(this.world.plugin(name));
    } catch {
      this.verifies.push("loud");
      return;
    }
    this.verifies.push(this.world.logs.length + this.world.sunk.length === written ? "quiet" : "loud");
  }

  #nameOf(plugin: bigint): string {
    const name = [...this.world.registered()].find(([, handle]) => handle === plugin)?.[0];
    if (name === undefined) {
      throw new Error(`The plan names a plugin ${plugin} the driver never registered.`);
    }
    return name;
  }

  #ledgerNames(status: number): string[] {
    if (this.world.host.destroyed) {
      return [];
    }
    return this.world.host.core
      .ledger()
      .value!.rows.filter((row) => row.status === status)
      .map((row) => row.importName ?? "")
      .sort();
  }

  observers(): Record<string, Observer> {
    return {
      plans: () => this.plans.map((plan) => [...plan]),
      trace: (expectation) => this.#traceBefore(expectation),
      active: () => this.#ledgerNames(PluginStatus.Active),
      forgotten: () => [...this.world.registered()].filter(([, plugin]) => this.world.host.plugin(plugin) === undefined).map(([name]) => name).sort(),
      pending: () => [...this.#pending].sort(),
      verifies: () => [...this.verifies],
      loud: () => (this.#destroying ? this.#loudSoFar() - this.#loudFrom + this.#loud : this.#loud),
    };
  }

  /** The `before` pairs as asked, each one the trace breaks marked so, so the answer equals `then` only when all hold. */
  #traceBefore(expectation: unknown): { before: unknown[] } {
    const pairs = (expectation as { before?: readonly (readonly [string, string])[] }).before;
    if (pairs === undefined) {
      throw new Error("A lifecycle vector's trace is judged with before, and this one names no before.");
    }
    return {
      before: pairs.map(([earlier, later]) => {
        const earlierAt = this.trace.indexOf(earlier);
        const laterAt = this.trace.indexOf(later);
        return earlierAt !== -1 && laterAt !== -1 && earlierAt < laterAt ? [earlier, later] : [earlier, later, `not in that order in ${JSON.stringify(this.trace)}`];
      }),
    };
  }
}

/** Builds the vector's plugins as values with entries that run their actions, drives its steps, and answers the run. */
export async function driveLifecycle(vector: LayerVector, world: DriverWorld): Promise<Record<string, Observer>> {
  const given = checkGiven(vector);
  const run = new LifecycleRun(world);
  world.register(given.plugins.map((plugin) => run.built(plugin)));
  for (const step of given.steps) {
    await run.run(step);
  }
  await settled();
  return run.observers();
}
