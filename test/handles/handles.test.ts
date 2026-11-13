import { describe, expect, it } from "vitest";
import { Status } from "../../src/core/index.ts";
import { HandleTable, HoldingTable } from "../../src/handles/index.ts";
import { createRecordedCore, openPlugin } from "../real-core.ts";

const provider = { importName: "alpha", services: { provides: [{ id: "alpha:greeting" }] } };
const consumer = { importName: "beta", services: { consumes: [{ id: "alpha:greeting" }] } };

function holdingCore() {
  const recorded = createRecordedCore();
  const holdings = new HoldingTable<object>();
  recorded.core.setDispatcher((event) => holdings.apply(event));
  const alpha = openPlugin(recorded.core, provider);
  const beta = openPlugin(recorded.core, consumer);
  return { ...recorded, holdings, alpha, beta };
}

describe("the holding table", () => {
  it("drops a holding when the core revokes it, and answers the stale handle absent", () => {
    const { core, holdings, alpha, beta } = holdingCore();
    const greeting = {};
    const registration = core.registerService(alpha, "alpha:greeting").value!;
    const implementation = core.getService(beta, "alpha:greeting").value!;
    holdings.hold(beta, implementation, greeting);
    expect(holdings.lookup(beta, implementation)).toBe(greeting);

    core.unregister(registration);
    const reregistered = core.registerService(alpha, "alpha:greeting").value!;

    expect(holdings.lookup(beta, implementation)).toBeUndefined();
    expect(reregistered).not.toBe(registration);
    expect(holdings.lookup(beta, reregistered)).toBeUndefined();
  });

  it("drops what a released plugin took late once the core forgets it", () => {
    const { core, holdings, alpha, beta } = holdingCore();
    core.registerService(alpha, "alpha:greeting");
    core.releasePlugin(beta);
    const late = core.getService(beta, "alpha:greeting").value!;
    holdings.hold(beta, late, {});

    expect(core.forgetPlugin(beta).status).toBe(Status.Ok);
    holdings.forget(beta);

    expect(holdings.lookup(beta, late)).toBeUndefined();
  });

  it("keeps a holding no event has ended", () => {
    const { core, holdings, alpha, beta } = holdingCore();
    const greeting = {};
    core.registerService(alpha, "alpha:greeting");
    const implementation = core.getService(beta, "alpha:greeting").value!;
    holdings.hold(beta, implementation, greeting);

    core.watchService(beta, "alpha:greeting");

    expect(holdings.lookup(beta, implementation)).toBe(greeting);
  });
});

describe("the handle table", () => {
  it("answers the very object it was given, and a dropped or unknown handle absent", () => {
    const table = new HandleTable<object>();
    const provided = {};
    table.add(5n, provided);

    expect(table.lookup(5n)).toBe(provided);
    expect(table.drop(5n)).toBe(true);
    expect(table.lookup(5n)).toBeUndefined();
    expect(table.lookup(6n)).toBeUndefined();
  });
});
