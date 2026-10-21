import { describe, expect, it } from "vitest";
import { activationOrder, order, readOffer, readRequirement } from "../../src/engine/index.js";
import type { ActivationUnit } from "../../src/engine/index.js";
import type { PluginManifest } from "../../src/index.js";

function manifest(id: string, services: PluginManifest["services"]): PluginManifest {
  return { id, api: 1, services } as PluginManifest;
}

function unit(id: string, provides: string[], requires: { id: string; optional: boolean }[]): ActivationUnit {
  return {
    id,
    provides: provides.map((offered) => ({ kind: "service", id: offered })),
    requires: requires.map((need) => ({ kind: "service", id: need.id, optional: need.optional, degradable: false })),
  };
}

describe("readRequirement", () => {
  it("reads a bare id as optional and not degradable", () => {
    expect(readRequirement("a:x")).toEqual({ id: "a:x", optional: true, degradable: false, constraints: {} });
  });

  it("defaults an object form the same way and drops non-numeric constraints", () => {
    const declared = { id: "a:x", constraints: { size: 3, label: "big" } } as never;
    expect(readRequirement(declared)).toEqual({ id: "a:x", optional: true, degradable: false, constraints: { size: 3 } });
  });

  it("reads an offer in either form", () => {
    expect(readOffer("a:x")).toEqual({ id: "a:x", attributes: {} });
    expect(readOffer({ id: "a:x", attributes: { speed: 2 } })).toEqual({ id: "a:x", attributes: { speed: 2 } });
  });
});

describe("activationOrder", () => {
  it("orders an object-form consumer after the provider of its service", () => {
    const plan = activationOrder([
      manifest("consumer", { consumes: [{ id: "a:x" }] }),
      manifest("provider", { provides: ["a:x"] }),
    ]);
    expect(plan.order).toEqual(["provider", "consumer"]);
  });

  it("refuses an object-form requirement that is not optional and has no provider, but not a bare one", () => {
    const plan = activationOrder([
      manifest("strict", { consumes: [{ id: "a:x", optional: false }] }),
      manifest("lenient", { consumes: ["a:x"] }),
    ]);
    expect(plan.refusals.map((refusal) => refusal.pluginId)).toEqual(["strict"]);
    expect(plan.order).toEqual(["lenient"]);
  });
});

describe("activationOrder with host-provided services", () => {
  it("meets a required need from the host without refusing it or its consumer", () => {
    const plan = activationOrder(
      [
        manifest("needy", { consumes: [{ id: "host:x", optional: false }] }),
        manifest("downstream", { consumes: [{ id: "needy:y", optional: false }], provides: [] }),
        manifest("needy-provider", { provides: ["needy:y"], consumes: [{ id: "host:x", optional: false }] }),
      ],
      ["host:x"],
    );
    expect(plan.refusals).toEqual([]);
    expect(plan.order).toHaveLength(3);
    expect(plan.order.indexOf("needy-provider")).toBeLessThan(plan.order.indexOf("downstream"));
  });

  it("does not list the host among the units to activate", () => {
    const plan = activationOrder([manifest("only", { consumes: [{ id: "host:x", optional: false }] })], ["host:x"]);
    expect(plan.order).toEqual(["only"]);
  });
});

describe("order", () => {
  it("propagates a refusal to every consumer of a refused provider", () => {
    const plan = order(
      [unit("c", [], [{ id: "b", optional: false }]), unit("b", ["b"], [{ id: "a", optional: false }])],
      "service",
    );
    expect(plan.refusals.map((refusal) => refusal.pluginId).sort()).toEqual(["b", "c"]);
    expect(plan.order).toEqual([]);
  });

  it("reports a three-member cycle once, with all three, and refuses none of them", () => {
    const plan = order(
      [
        unit("p", ["p"], [{ id: "r", optional: false }]),
        unit("q", ["q"], [{ id: "p", optional: false }]),
        unit("r", ["r"], [{ id: "q", optional: false }]),
      ],
      "service",
    );
    expect(plan.cycles).toHaveLength(1);
    expect([...(plan.cycles[0] ?? [])].sort()).toEqual(["p", "q", "r"]);
    expect(plan.refusals).toEqual([]);
    expect(plan.order).toEqual([]);
  });

  it("throws when two units share an id", () => {
    expect(() => order([unit("a", [], []), unit("a", [], [])], "service")).toThrow(/share the id "a"/);
  });
});
