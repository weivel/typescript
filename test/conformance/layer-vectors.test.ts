import { describe, expect, it } from "vitest";
import { PluginStatus } from "../../src/core/index.ts";
import { readLayerVector, witnessLayerVector, type LayerVector, type LayerWitness } from "../../src/conformance/index.ts";
import type { Host } from "../../src/host/index.ts";
import { coreLibraryPath } from "../real-core.ts";
import { standardLibraryPath } from "../real-standard.ts";
import { layerVectorDirectory } from "./kit.ts";

async function witness(id: string, inspect?: (host: Host) => void): Promise<{ vector: LayerVector; witness: LayerWitness }> {
  const vector = readLayerVector(layerVectorDirectory, id);
  return { vector, witness: await witnessLayerVector(vector, { coreLibraryPath, standardLibraryPath, ...(inspect === undefined ? {} : { inspect }) }) };
}

describe("consume/a-throwing-listener-does-not-silence-the-others", () => {
  it("lets every other listener hear, keeps what the throwing one was handed, and reports no refusal", async () => {
    const { vector, witness: seen } = await witness("consume/a-throwing-listener-does-not-silence-the-others");

    expect(Object.keys(seen.observed)).toEqual(["heard", "reported", "refusal"]);
    expect(seen.observed.heard).toEqual(vector.then.heard);
    expect(seen.observed.reported).toEqual(vector.then.reported);
    expect(seen.observed.refusal).toEqual(vector.then.refusal);
    const errors = seen.logs.filter((entry) => entry.level === "error");
    expect(errors.map((entry) => entry.source)).toEqual(["bad"]);
  });
});

describe("consume/a-refused-verify-quarantines-the-plugin", () => {
  it("quarantines the refused plugin in the step of its check, its watch stopping there, and reports no refusal", async () => {
    let trackedByQuarantined: number[] = [];
    const { vector, witness: seen } = await witness("consume/a-refused-verify-quarantines-the-plugin", (host) => {
      const rows = host.core.ledger().value!.rows.filter((row) => row.status === PluginStatus.Quarantined);
      trackedByQuarantined = rows.map((row) => host.contexts.tracked(row.plugin));
    });

    expect(Object.keys(seen.observed)).toEqual(["heard", "reported", "refusal", "quarantined", "quarantineReason"]);
    expect(seen.observed.heard).toEqual(vector.then.heard);
    expect(seen.observed.reported).toEqual(vector.then.reported);
    expect(seen.observed.refusal).toEqual(vector.then.refusal);
    expect(seen.observed.quarantined).toEqual(vector.then.quarantined);
    expect(seen.observed.quarantineReason).toEqual(vector.then.quarantineReason);
    expect(trackedByQuarantined).toEqual([0]);
  });
});

describe("want/a-registration-at-the-deadline-loses", () => {
  it("times the want out at the deadline, never serves it, and rejects it with the core's refusal", async () => {
    const { vector, witness: seen } = await witness("want/a-registration-at-the-deadline-loses");

    expect(Object.keys(seen.observed)).toEqual(["settled", "timedOut", "atMillis", "refusal"]);
    expect(seen.observed.settled).toEqual(vector.then.settled);
    expect(seen.observed.timedOut).toEqual(vector.then.timedOut);
    expect(seen.observed.atMillis).toEqual(vector.then.atMillis);
    expect(seen.observed.refusal).toEqual(vector.then.refusal);
  });
});
