import { describe, expect, it } from "vitest";
import { PluginStatus } from "../../src/core/index.ts";
import { readLayerVector, witnessLayerVector, type LayerVector, type LayerWitness } from "../../src/conformance/index.ts";
import type { Host } from "../../src/host/index.ts";
import { coreLibraryPath } from "../real-core.ts";
import { layerVectorDirectory } from "./kit.ts";

async function witness(id: string, inspect?: (host: Host) => void): Promise<{ vector: LayerVector; witness: LayerWitness }> {
  const vector = readLayerVector(layerVectorDirectory, id);
  return { vector, witness: await witnessLayerVector(vector, { coreLibraryPath, ...(inspect === undefined ? {} : { inspect }) }) };
}

describe("consume/a-throwing-listener-does-not-silence-the-others", () => {
  it("lets every other listener hear, keeps what the throwing one was handed, and reports no refusal", async () => {
    const { vector, witness: seen } = await witness("consume/a-throwing-listener-does-not-silence-the-others");

    expect(Object.keys(seen.observed)).toEqual(["heard", "reported", "refusal"]);
    expect(seen.observed.heard).toEqual(vector.then.heard);
    expect(seen.observed.reported).toEqual(vector.then.reported);
    expect(seen.observed.refusal).toEqual(vector.then.refusal);
    expect(seen.logs.filter((entry) => entry.level === "error")).toEqual([]);
    expect(seen.sunk.map((error) => (error as Error).message)).toEqual([expect.stringMatching(/^the throwing listener of /)]);
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

describe("want/a-timed-want-arms-the-timer-at-its-deadline", () => {
  it("arms the timer at the announced deadline and disarms it once the want has timed out there", async () => {
    const { vector, witness: seen } = await witness("want/a-timed-want-arms-the-timer-at-its-deadline");

    expect(Object.keys(seen.observed)).toEqual(Object.keys(vector.then));
    expect(seen.observed).toEqual(vector.then);
  });
});

describe("want/a-settled-want-disarms-the-timer", () => {
  it("disarms the timer when the registration settles the want, so it never fires", async () => {
    const { vector, witness: seen } = await witness("want/a-settled-want-disarms-the-timer");

    expect(Object.keys(seen.observed)).toEqual(Object.keys(vector.then));
    expect(seen.observed).toEqual(vector.then);
  });
});

describe("want/a-registration-past-an-unfired-deadline-loses", () => {
  it("advances the core to the clock before the registration, though the timer never fired, so the want times out", async () => {
    const { vector, witness: seen } = await witness("want/a-registration-past-an-unfired-deadline-loses");

    expect(Object.keys(seen.observed)).toEqual(Object.keys(vector.then));
    expect(seen.observed).toEqual(vector.then);
  });
});

describe("lifecycle/an-awaited-want-does-not-hold-back-a-later-plugin", () => {
  it("starts the later plugin while the earlier one's activate waits on the service it registers", async () => {
    const { vector, witness: seen } = await witness("lifecycle/an-awaited-want-does-not-hold-back-a-later-plugin");

    expect(Object.keys(seen.observed)).toEqual(Object.keys(vector.then));
    expect(seen.observed).toEqual(vector.then);
  });
});

describe("lifecycle/a-release-deactivates-then-releases-then-forgets", () => {
  it("deactivates the plugin while whole, hands it its stopped want, then forgets it", async () => {
    const { vector, witness: seen } = await witness("lifecycle/a-release-deactivates-then-releases-then-forgets");

    expect(Object.keys(seen.observed)).toEqual(Object.keys(vector.then));
    expect(seen.observed).toEqual(vector.then);
  });
});

describe("lifecycle/destroy-releases-a-plugin-whose-activate-is-in-flight", () => {
  it("releases the in-flight plugin, leaves no want pending, and answers a later verify quietly", async () => {
    const { vector, witness: seen } = await witness("lifecycle/destroy-releases-a-plugin-whose-activate-is-in-flight");

    expect(Object.keys(seen.observed)).toEqual(Object.keys(vector.then));
    expect(seen.observed).toEqual(vector.then);
  });
});
