import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PluginStatus, RefusalCode } from "../../src/core/index.ts";
import { RefusalError, type PluginContext } from "../../src/context/index.ts";
import { createHostWorld, pluginDirectory, type HostWorld } from "./world.ts";

const layerVectorDirectory = join(import.meta.dirname, "..", "..", "siblings", "conformance", "vectors", "layer");

interface Capabilities {
  readonly provides: readonly string[];
  readonly consumes: readonly string[];
}

type Step =
  | { readonly plugin: string; readonly watch: string }
  | { readonly plugin: string; readonly provide: string }
  | { readonly plugin: string; readonly verify: true }
  | { readonly plugin: string; readonly release: true };

interface ConsumeVector {
  readonly id: string;
  readonly given: { readonly plugins: readonly { id: string; capabilities: Capabilities }[]; readonly steps: readonly Step[] };
  readonly then: {
    readonly heard: { readonly equals: readonly (readonly [string, string])[][] };
    readonly reported: { readonly equals: readonly (readonly [string, string])[] };
    readonly refusal: null;
    readonly quarantined: { readonly equals: readonly string[] };
    readonly quarantineReason: { readonly code: string; readonly subject: string; readonly hasFix: boolean };
  };
}

function readVector(relativePath: string): ConsumeVector {
  return JSON.parse(readFileSync(join(layerVectorDirectory, relativePath), "utf8")) as ConsumeVector;
}

/** The core's code for a kit name such as `activation_mismatch`. */
function refusalCodeNamed(name: string): number {
  const key = name
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("") as keyof typeof RefusalCode;
  const code = RefusalCode[key];
  if (code === undefined) {
    throw new Error(`the kit names a refusal code this layer does not know: ${name}`);
  }
  return code;
}

interface Run {
  readonly world: HostWorld;
  readonly handles: Map<string, bigint>;
  readonly contexts: Map<string, PluginContext>;
  readonly heard: [string, string][][];
  readonly reported: [string, string][];
  readonly refusals: RefusalError[];
}

function openPlugins(vector: ConsumeVector): Run {
  const world = createHostWorld();
  const directory = pluginDirectory(
    vector.given.plugins.map((given) => ({
      manifest: {
        importName: given.id,
        capabilities: given.capabilities,
        ...(given.capabilities.provides.length > 0 ? { entry: `${given.id}.js` } : {}),
      },
    })),
  );
  const handles = new Map(world.host.discover(directory).registered.map((hosted) => [hosted.manifest.importName, hosted.plugin]));
  const run: Run = { world, handles, contexts: new Map(), heard: [], reported: [], refusals: [] };
  for (const given of vector.given.plugins) {
    const context = world.host.open(handles.get(given.id)!);
    context.events.listen((event) => {
      if (event.kind === "reach-refused") {
        run.reported.push([given.id, event.id ?? ""]);
      }
    });
    run.contexts.set(given.id, context);
  }
  return run;
}

async function runStep(run: Run, step: Step): Promise<void> {
  const context = run.contexts.get(step.plugin)!;
  const plugin = run.handles.get(step.plugin)!;
  if ("watch" in step) {
    const heard: [string, string][] = [];
    run.heard.push(heard);
    context.capabilities.watch(context.capability<{ provider: string }>(step.watch), (implementation, change) =>
      heard.push([implementation.provider, change]),
    );
  } else if ("provide" in step) {
    context.provide(context.capability(step.provide), { provider: step.plugin });
  } else if ("verify" in step) {
    run.world.host.verify(plugin);
  } else if ("release" in step) {
    await run.world.host.release(plugin);
  } else {
    throw new Error(`a step this suite does not drive: ${JSON.stringify(step)}`);
  }
}

async function runVector(vector: ConsumeVector): Promise<Run> {
  const run = openPlugins(vector);
  for (const step of vector.given.steps) {
    try {
      await runStep(run, step);
    } catch (error) {
      if (!(error instanceof RefusalError)) {
        throw error;
      }
      run.refusals.push(error);
    }
  }
  return run;
}

describe("consume/a-refused-verify-quarantines-the-plugin", () => {
  it("quarantines the refused plugin in the step of its check, its watch stopping there, and reports no refusal", async () => {
    const vector = readVector("consume/a-refused-verify-quarantines-the-plugin.json");

    const run = await runVector(vector);

    expect(vector.id).toBe("consume/a-refused-verify-quarantines-the-plugin");
    expect(run.heard).toEqual(vector.then.heard.equals);
    expect(run.reported).toEqual(vector.then.reported.equals);
    expect(run.refusals[0] ?? null).toEqual(vector.then.refusal);
    const rows = run.world.host.core.ledger().value!.rows.filter((row) => row.status === PluginStatus.Quarantined);
    expect(rows.map((row) => row.importName)).toEqual(vector.then.quarantined.equals);
    const reason = vector.then.quarantineReason;
    expect(rows[0]!.refusal).toMatchObject({ code: refusalCodeNamed(reason.code), subject: reason.subject, hasFix: reason.hasFix });
    expect(run.world.host.contexts.tracked(rows[0]!.plugin)).toBe(0);
  });
});
