import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginContext } from "../../src/context/index.ts";
import type { BoundDefinition, LoadedLibrary } from "../../src/host/index.ts";
import type { LibraryDeclaration } from "../../src/standard/index.ts";
import { realStandard } from "../real-standard.ts";
import { alive, createHostWorld, describedLibraryPath, plugin, pluginDirectory, registerDirectory } from "./world.ts";

const fixtureDirectory = join(import.meta.dirname, "..", "..", "siblings", "standard", "test", "described");
const mirrorId = "described-mirror";
const walkerId = "described-walker";
const mirroring = "described.mirroring";

const status = { WEIVEL_STATUS_OK: 0, WEIVEL_STATUS_NONE: 1, WEIVEL_STATUS_MALFORMED: 2, WEIVEL_STATUS_REFUSED: 3, WEIVEL_STATUS_OUT_OF_MEMORY: 4 };

function declaration(): LibraryDeclaration {
  const read = realStandard().readLibrary(readFileSync(join(fixtureDirectory, "library.json"), "utf8"));
  if (read.value === undefined) {
    throw new Error(`the standard refused library.json: ${read.refusal?.detail}`);
  }
  return read.value;
}

interface Loaded {
  readonly library: LoadedLibrary;
  readonly context: PluginContext;
}

function loaded(): Loaded {
  const standard = realStandard();
  const world = createHostWorld({}, { descriptionCheck: (description, definition) => standard.checkDescription(description, definition) });
  const library = alive(world.host.loadLibrary(declaration(), describedLibraryPath));
  const holder = plugin({ importName: "holder", services: { consumes: [mirrorId, walkerId] }, capabilities: { consumes: [mirroring] } });
  const handles = registerDirectory(world, pluginDirectory([holder]));
  return { library, context: alive(world.host.open(handles.registered.get("holder")!)) };
}

function serviceOf(context: PluginContext, id: string): BoundDefinition {
  return context.services.get(context.service<BoundDefinition>(id))!;
}

describe("the enums of a bound definition", () => {
  it("are its description's, by the names its header spells, beside weivel_status", () => {
    const { context } = loaded();

    const enums = context.services.enumsOf(serviceOf(context, mirrorId))!;

    expect({ ...enums.described_shade }).toEqual({ DESCRIBED_SHADE_LIGHT: 1, DESCRIBED_SHADE_DARK: 2 });
    expect({ ...enums.described_tier }).toEqual({ DESCRIBED_TIER_LOW: 0, DESCRIBED_TIER_HIGH: 7 });
    expect({ ...enums.weivel_status }).toEqual(status);
    expect(Object.isFrozen(enums)).toBe(true);
    expect(Object.isFrozen(enums.described_shade)).toBe(true);
    expect(Object.getPrototypeOf(enums)).toBeNull();
  });

  it("are a carried definition's own description's", async () => {
    const { context } = loaded();
    const loan = (await serviceOf(context, walkerId).lend!()) as { counter: BoundDefinition; release(): void };

    const enums = context.services.enumsOf(loan.counter)!;

    expect({ ...enums.weivel_status }).toEqual(status);
    expect(enums.described_shade).toBeUndefined();
    loan.release();
  });

  it("are undefined for an object no description bound", () => {
    const { context } = loaded();

    expect(context.services.enumsOf({ add: async () => 0 })).toBeUndefined();
    expect(context.services.enumsOf(undefined)).toBeUndefined();
  });
});

describe("the enums of a published contract", () => {
  it("are its description's for the capability, until the library that published it unloads", () => {
    const { library, context } = loaded();
    const capability = context.capability(mirroring);

    expect({ ...context.capabilities.enumsOf(capability)!.described_tier }).toEqual({ DESCRIBED_TIER_LOW: 0, DESCRIBED_TIER_HIGH: 7 });
    expect({ ...context.capabilities.enumsOf(capability)!.weivel_status }).toEqual(status);
    expect(context.capabilities.enumsOf(context.capability("described.unpublished"))).toBeUndefined();

    library.unload();

    expect(context.capabilities.enumsOf(capability)).toBeUndefined();
  });
});
