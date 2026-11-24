import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RefusalCode, type Manifest } from "../../src/core/index.ts";
import { ContractMismatchError, type PluginContext } from "../../src/context/index.ts";
import type { LoadedLibrary } from "../../src/host/index.ts";
import type { LibraryDeclaration } from "../../src/standard/index.ts";
import { activated, alive, createHostWorld, type HostWorld } from "../host/world.ts";
import { stubHostDirectory, stubHostLibraryPath } from "../program/world.ts";
import { realStandard } from "../real-standard.ts";

const tally = "stub-host.tally";
const unpublished = "elsewhere.tally";

function contractDeclaration(): LibraryDeclaration {
  const read = realStandard().readLibrary(readFileSync(join(stubHostDirectory, "library-declares-a-contract.json"), "utf8"));
  if (read.value === undefined) {
    throw new Error(`the standard refused the declaration: ${read.refusal?.detail}`);
  }
  return read.value;
}

function checkingWorld(): HostWorld {
  const standard = realStandard();
  return createHostWorld({}, { descriptionCheck: (description, definition) => standard.checkDescription(description, definition) });
}

function loadContract(world: HostWorld): LoadedLibrary {
  return alive(world.host.loadLibrary(contractDeclaration(), stubHostLibraryPath));
}

function providerContext(world: HostWorld): PluginContext {
  const manifest = { importName: "provider", api: 1, capabilities: { provides: [tally, unpublished] } } as Manifest;
  const plugin = alive(world.host.register(manifest, { activate() {} })).plugin!;
  return alive(world.host.open(plugin));
}

function implementation(...operations: string[]): Record<string, () => void> {
  return Object.fromEntries(operations.map((operation) => [operation, () => {}]));
}

function mismatchOf(provide: () => void): ContractMismatchError {
  try {
    provide();
  } catch (error) {
    if (error instanceof ContractMismatchError) {
      return error;
    }
    throw error;
  }
  throw new Error("the provide was not refused");
}

describe("a provide of a capability a loaded library publishes a contract for", () => {
  it("is refused as contract-mismatch, naming the operation the implementation lacks", () => {
    const world = checkingWorld();
    loadContract(world);
    const context = providerContext(world);

    const mismatch = mismatchOf(() => context.provide(context.capability(tally), implementation("run", "next")));

    expect({ code: mismatch.code, capability: mismatch.capability, subject: mismatch.subject }).toEqual({
      code: "contract-mismatch",
      capability: tally,
      subject: "count",
    });
  });

  it("names the first missing operation in the description's order", () => {
    const world = checkingWorld();
    loadContract(world);
    const context = providerContext(world);

    expect(mismatchOf(() => context.provide(context.capability(tally), implementation("run"))).subject).toBe("count");
    expect(mismatchOf(() => context.provide(context.capability(tally), implementation("count", "run"))).subject).toBe("next");
  });

  it("counts only a function as an offered operation, and refuses what is not an object", () => {
    const world = checkingWorld();
    loadContract(world);
    const context = providerContext(world);

    const notCallable = { ...implementation("run", "next"), count: 1 };
    expect(mismatchOf(() => context.provide(context.capability(tally), notCallable)).subject).toBe("count");
    expect(mismatchOf(() => context.provide(context.capability(tally), null)).subject).toBe("count");
  });

  it("accepts every operation answering a status, with no release required and anything more allowed", () => {
    const world = checkingWorld();
    loadContract(world);
    const context = providerContext(world);

    expect(() => context.provide(context.capability(tally), implementation("count", "run", "next", "release_run", "reset"))).not.toThrow();
  });

  it("provides nothing once refused, so an activation that declared the capability is quarantined for not providing it", async () => {
    const world = checkingWorld();
    loadContract(world);
    const manifest = { importName: "partial", api: 1, capabilities: { provides: [tally] } } as Manifest;
    const entry = {
      activate(context: PluginContext) {
        mismatchOf(() => context.provide(context.capability(tally), implementation("count")));
      },
    };
    const plugin = alive(world.host.register(manifest, entry)).plugin!;

    const { outcomes } = await activated(world.host, [plugin]);

    expect(outcomes[0]).toMatchObject({ state: "quarantined", refusal: { code: RefusalCode.ActivationMismatch } });
  });

  it("is no longer checked once the library publishing the contract is unloaded", () => {
    const world = checkingWorld();
    loadContract(world).unload();
    const context = providerContext(world);

    expect(() => context.provide(context.capability(tally), {})).not.toThrow();
  });
});

describe("a provide of a capability no loaded library publishes a contract for", () => {
  it("is provided unchecked", () => {
    const world = checkingWorld();
    loadContract(world);
    const context = providerContext(world);

    expect(() => context.provide(context.capability(unpublished), {})).not.toThrow();
  });
});

describe("a library publishing a contract", () => {
  it("is refused at the load while another live library publishes one for the same capability", () => {
    const world = checkingWorld();
    loadContract(world);
    const second: LibraryDeclaration = { ...contractDeclaration(), importName: "second-tally", services: [] };

    expect(() => world.host.loadLibrary(second, stubHostLibraryPath)).toThrow(`A contract for ${tally} is already published`);
  });

  it("is refused at the load when its contract's description is declared to a host given no description check", () => {
    const world = createHostWorld();

    expect(() => world.host.loadLibrary(contractDeclaration(), stubHostLibraryPath)).toThrow("given no descriptionCheck");
  });
});
