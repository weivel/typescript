import { PluginStatus } from "../core/index.js";
import { RefusalError, type PluginContext } from "../context/index.js";
import { refuseUnknownKeys, type Observer } from "./expectations.js";
import { kitRefusal } from "./refusals.js";
import type { LayerVector } from "./vectors.js";
import type { DriverWorld, WrittenManifest } from "./world.js";

interface GivenPlugin {
  readonly id: string;
  readonly capabilities: { readonly provides: readonly string[]; readonly consumes: readonly string[] };
}

type Step =
  | { readonly plugin: string; readonly watch: string; readonly throws?: boolean }
  | { readonly plugin: string; readonly provide: string }
  | { readonly plugin: string; readonly verify: true }
  | { readonly plugin: string; readonly release: true };

interface ConsumeGiven {
  readonly plugins: readonly GivenPlugin[];
  readonly steps: readonly Step[];
}

/** The object a step's plugin provides: the kit's `heard` names an implementation by its provider. */
interface ProvidedImplementation {
  readonly provider: string;
}

const actionKeys = ["watch", "provide", "verify", "release"] as const;

function checkStep(vectorId: string, step: Step, index: number): void {
  const where = `The vector ${vectorId}'s step ${index}`;
  const action = actionKeys.filter((key) => key in step);
  if (action.length !== 1) {
    throw new Error(`${where} names ${action.length} actions; a step names exactly one of ${actionKeys.join(", ")}.`);
  }
  refuseUnknownKeys(where, step, action[0] === "watch" ? ["plugin", "watch", "throws"] : ["plugin", action[0]!]);
}

function checkGiven(vector: LayerVector): ConsumeGiven {
  refuseUnknownKeys(`The vector ${vector.id}'s given`, vector.given, ["plugins", "steps"]);
  const given = vector.given as unknown as ConsumeGiven;
  for (const plugin of given.plugins) {
    refuseUnknownKeys(`The vector ${vector.id}'s plugin ${plugin.id}`, plugin, ["id", "capabilities"]);
  }
  given.steps.forEach((step, index) => checkStep(vector.id, step, index));
  return given;
}

/** The manifest of a given plugin, its capabilities exactly as written, so the core reads the declaration itself. */
function manifestOf(plugin: GivenPlugin): WrittenManifest {
  return {
    importName: plugin.id,
    capabilities: plugin.capabilities,
    ...(plugin.capabilities.provides.length > 0 ? { entry: `${plugin.id}.ts` } : {}),
  };
}

class ConsumeRun {
  readonly heard: [string, string][][] = [];
  readonly reported: [string, string][] = [];
  readonly refusals: RefusalError[] = [];
  readonly #contexts = new Map<string, PluginContext>();

  constructor(
    readonly world: DriverWorld,
    plugins: readonly GivenPlugin[],
  ) {
    world.discover(plugins.map(manifestOf));
    for (const plugin of plugins) {
      const context = world.open(plugin.id);
      context.events.listen((event) => {
        if (event.kind === "reach-refused") {
          this.reported.push([plugin.id, event.id ?? ""]);
        }
      });
      this.#contexts.set(plugin.id, context);
    }
  }

  async run(step: Step): Promise<void> {
    try {
      await this.#perform(step);
    } catch (error) {
      if (!(error instanceof RefusalError)) {
        throw error;
      }
      this.refusals.push(error);
    }
  }

  async #perform(step: Step): Promise<void> {
    const context = this.#contexts.get(step.plugin);
    if (context === undefined) {
      throw new Error(`A step names a plugin the vector does not give: ${step.plugin}.`);
    }
    if ("watch" in step) {
      this.#watch(context, step.watch, step.throws === true);
    } else if ("provide" in step) {
      context.provide(context.capability<ProvidedImplementation>(step.provide), { provider: step.plugin });
    } else if ("verify" in step) {
      this.world.host.verify(this.world.plugin(step.plugin));
    } else {
      await this.world.host.release(this.world.plugin(step.plugin));
    }
  }

  /** A throwing watch records what it was handed, then throws on every call. */
  #watch(context: PluginContext, capability: string, throws: boolean): void {
    const heard: [string, string][] = [];
    this.heard.push(heard);
    context.capabilities.watch(context.capability<ProvidedImplementation>(capability), (implementation, change) => {
      heard.push([implementation.provider, change]);
      if (throws) {
        throw new Error(`the throwing listener of ${capability} was handed ${implementation.provider} ${change}`);
      }
    });
  }

  quarantinedRows() {
    return this.world.host.core.ledger().value!.rows.filter((row) => row.status === PluginStatus.Quarantined);
  }

  observers(): Record<string, Observer> {
    return {
      heard: () => this.heard,
      reported: () => this.reported,
      refusal: () => (this.refusals[0] === undefined ? null : kitRefusal(this.refusals[0])),
      quarantined: () => this.quarantinedRows().map((row) => row.importName),
      quarantineReason: () => {
        const first = this.quarantinedRows()[0];
        return first === undefined ? null : kitRefusal(first.refusal);
      },
    };
  }
}

/** Builds the vector's plugins through the host, drives its steps in order, and answers what the run shows. */
export async function driveConsume(vector: LayerVector, world: DriverWorld): Promise<Record<string, Observer>> {
  const given = checkGiven(vector);
  const run = new ConsumeRun(world, given.plugins);
  for (const step of given.steps) {
    await run.run(step);
  }
  return run.observers();
}
