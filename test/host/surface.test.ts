import { describe, expect, it } from "vitest";
import * as coreModule from "../../src/core/index.ts";
import * as hostModule from "../../src/host/index.ts";
import { Core, PluginStatus } from "../../src/core/index.ts";
import { alive, createHostWorld } from "./world.ts";

const wrapperHooks = ["setDispatcher", "setClock", "setDeadlineReader", "holdDispatch"];

describe("what the host hands its caller", () => {
  it("is nothing of the wrapper: no core and no contexts", () => {
    const world = createHostWorld();

    expect("core" in world.host).toBe(false);
    expect("contexts" in world.host).toBe(false);
  });

  it("is its ledger, every plugin's row as the core keeps it", () => {
    const world = createHostWorld();
    const plugin = alive(world.host.register({ importName: "kept", api: 1 }, { activate: () => undefined })).plugin!;

    const rows = alive(world.host.ledger()).rows;

    expect(rows.map((row) => [row.plugin, row.importName, row.status])).toEqual([[plugin, "kept", PluginStatus.Registered]]);
  });

  it("answers its ledger as destroyed once the host is", async () => {
    const world = createHostWorld();
    await world.host.destroy();

    expect(hostModule.isHostDestroyed(world.host.ledger())).toBe(true);
  });
});

describe("the core's public surface", () => {
  it("offers none of the wrapper's dispatch, clock or deadline hooks", () => {
    const methods = Object.getOwnPropertyNames(Core.prototype);

    for (const hook of wrapperHooks) {
      expect(methods).not.toContain(hook);
    }
  });

  it("exports nothing that reaches them, from the core module or the host module", () => {
    expect(Object.keys(coreModule)).not.toContain("wrapperHooks");
    expect(Object.keys(hostModule)).not.toContain("hostInternals");
  });
});
