import { describe, expect, it } from "vitest";
import { EmbeddedNulError, type Manifest } from "../../src/core/index.ts";
import type { Plugin } from "../../src/host/index.ts";
import { createWorld } from "../context/world.ts";
import { alive, createHostWorld, planned } from "../host/world.ts";
import { createRecordedCore } from "../real-core.ts";
import { realStandard } from "../real-standard.ts";

const inert: Plugin = { activate: () => undefined };

describe("a text with an embedded NUL", () => {
  it("is refused before the core in a manifest's import name, so the core registers nothing", () => {
    const { core } = createRecordedCore();

    expect(() => core.registerManifest({ importName: "al\u0000pha" })).toThrow(EmbeddedNulError);
    expect(core.ledger().value!.rows).toEqual([]);
  });

  it("is refused in every text a manifest carries, however deep", () => {
    const { core } = createRecordedCore();
    const manifests: Manifest[] = [
      { importName: "alpha", entry: "a\u0000.js" },
      { importName: "alpha", targets: ["t\u0000"] },
      { importName: "alpha", capabilities: { provides: ["screens\u0000"] } },
      { importName: "alpha", services: { provides: [{ id: "alpha:thing", attributes: [{ name: "n\u0000", value: 1 }] }] } },
      { importName: "alpha", services: { consumes: [{ id: "beta:thing", provider: "be\u0000ta" }] } },
      { importName: "alpha", permissions: ["p\u0000"] },
      { importName: "alpha", identity: "local:a\u0000" },
    ];

    for (const manifest of manifests) {
      expect(() => core.registerManifest(manifest)).toThrow(EmbeddedNulError);
    }
    expect(core.ledger().value!.rows).toEqual([]);
  });

  it("is refused as an id a plugin hands its context, the error reported to no sink", () => {
    const world = createWorld();
    const alpha = world.open({ importName: "alpha", services: { provides: [{ id: "alpha:thing" }] } });
    const dispatched = world.dispatched.length;

    expect(() => alpha.context.services.register(alpha.context.service("alpha:thing\u0000x"), {})).toThrow(EmbeddedNulError);
    expect(() => alpha.context.services.get(alpha.context.service("alpha:thing\u0000x"))).toThrow(EmbeddedNulError);
    expect(() => alpha.context.services.watch(alpha.context.service("alpha:thing\u0000x"), () => undefined)).toThrow(EmbeddedNulError);
    expect(() => alpha.context.capabilities.all(alpha.context.capability("screens\u0000x"))).toThrow(EmbeddedNulError);
    expect(world.dispatched.length).toBe(dispatched);
    expect(world.sunk).toEqual([]);
  });

  it("rejects a want of such an id without reaching the core", async () => {
    const world = createWorld();
    const beta = world.open({ importName: "beta", services: { consumes: [{ id: "alpha:thing" }] } });

    await expect(beta.context.services.want(beta.context.service("alpha:thing\u0000x"))).rejects.toThrow(EmbeddedNulError);
    expect(world.sunk).toEqual([]);
  });

  it("is refused by the host's registration and its host services, reported to no sink", () => {
    const errors: unknown[] = [];
    const world = createHostWorld({}, { onListenerError: (error) => void errors.push(error) });

    expect(() => world.host.register({ importName: "al\u0000pha", api: 1 }, inert)).toThrow(EmbeddedNulError);
    expect(() => world.host.registerHostService({ id: "echo\u0000x" }, {})).toThrow(EmbeddedNulError);
    expect(alive(world.host.ledger()).rows).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("is written out in the host's own reason when a plugin's activate threw one", async () => {
    const world = createHostWorld();
    const plugin = alive(
      world.host.register({ importName: "thrower", api: 1 }, {
        activate: () => {
          throw new Error("cut\u0000short");
        },
      }),
    ).plugin!;

    const [outcome] = await planned(world.host.activate([plugin])).outcomes;

    expect(outcome!.state).toBe("quarantined");
    expect(outcome!.refusal?.detail).toBe("its activate threw: cut\\0short");
  });

  it("is refused by the standard where it would cross as a C text", () => {
    const standard = realStandard();

    expect(() => standard.isSha256Hex(`${"0".repeat(64)}\u0000x`)).toThrow(EmbeddedNulError);
    expect(() => standard.discover("plugins\u0000x")).toThrow(EmbeddedNulError);
    expect(() => standard.expandMirror("https://example.com/{sha256}\u0000x", "0".repeat(64))).toThrow(EmbeddedNulError);
  });
});
