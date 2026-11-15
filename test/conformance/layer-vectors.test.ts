import { describe, expect, it } from "vitest";
import { PluginStatus } from "../../src/core/index.ts";
import { readLayerVector, witnessLayerVector, type LayerVector, type LayerWitness } from "../../src/conformance/index.ts";
import type { Host } from "../../src/host/index.ts";
import { coreLibraryPath } from "../real-core.ts";
import { echoLibraryPath } from "../host/world.ts";
import { layerVectorDirectory } from "./kit.ts";
import { hostInternals } from "../../src/host/host.ts";

async function witness(id: string, inspect?: (host: Host) => void): Promise<{ vector: LayerVector; witness: LayerWitness }> {
  const vector = readLayerVector(layerVectorDirectory, id);
  return { vector, witness: await witnessLayerVector(vector, { coreLibraryPath, echoLibraryPath, ...(inspect === undefined ? {} : { inspect }) }) };
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
      const rows = hostInternals(host).core.ledger().value!.rows.filter((row) => row.status === PluginStatus.Quarantined);
      trackedByQuarantined = rows.map((row) => hostInternals(host).contexts.tracked(row.plugin));
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

describe("lifecycle/events-of-an-activate-wait-for-every-activate-of-the-plan", () => {
  it("dispatches the registration an activate made only once every activate of the plan has been called", async () => {
    const { vector, witness: seen } = await witness("lifecycle/events-of-an-activate-wait-for-every-activate-of-the-plan");

    expect(Object.keys(seen.observed)).toEqual(Object.keys(vector.then));
    expect(seen.observed).toEqual(vector.then);
  });
});

describe("lifecycle/an-activate-that-settles-at-once-is-verified-before-the-next-starts", () => {
  it("verifies the provider before the consumer starts, so the consumer lists its implementation", async () => {
    const { vector, witness: seen } = await witness("lifecycle/an-activate-that-settles-at-once-is-verified-before-the-next-starts");

    expect(Object.keys(seen.observed)).toEqual(Object.keys(vector.then));
    expect(seen.observed).toEqual(vector.then);
  });
});

describe("lifecycle/an-activate-refused-at-once-is-quarantined-before-the-next-starts", () => {
  it("quarantines the refused provider before the consumer starts, so the consumer misses its service", async () => {
    const { vector, witness: seen } = await witness("lifecycle/an-activate-refused-at-once-is-quarantined-before-the-next-starts");

    expect(Object.keys(seen.observed)).toEqual(Object.keys(vector.then));
    expect(seen.observed).toEqual(vector.then);
  });
});

describe("library/a-definition-is-the-providers-own-pointer", () => {
  it("serves the very address the definition's symbol answered, and its echo answers through the library's own context", async () => {
    const { vector, witness: seen } = await witness("library/a-definition-is-the-providers-own-pointer");

    expect(Object.keys(seen.observed)).toEqual(Object.keys(vector.then));
    expect(seen.observed).toEqual(vector.then);
  });
});

describe("library/a-null-definition-fails-the-load", () => {
  it("refuses the load as the caller's mistake, registers neither service, and reports nothing", async () => {
    const { vector, witness: seen } = await witness("library/a-null-definition-fails-the-load");

    expect(Object.keys(seen.observed)).toEqual(Object.keys(vector.then));
    expect(seen.observed).toEqual(vector.then);
  });
});

describe("library/a-definition-below-its-size-fails-the-load", () => {
  it("refuses a struct one byte below two pointers as the caller's mistake, registering nothing", async () => {
    const { vector, witness: seen } = await witness("library/a-definition-below-its-size-fails-the-load");

    expect(Object.keys(seen.observed)).toEqual(Object.keys(vector.then));
    expect(seen.observed).toEqual(vector.then);
  });
});

describe("library/a-definition-at-its-size-loads", () => {
  it("loads a struct of exactly two pointers and serves it", async () => {
    const { vector, witness: seen } = await witness("library/a-definition-at-its-size-loads");

    expect(Object.keys(seen.observed)).toEqual(Object.keys(vector.then));
    expect(seen.observed).toEqual(vector.then);
  });
});

describe("library/an-unload-revokes-every-holding-of-a-definition", () => {
  it("revokes the definition to each holder by the core's event and serves it to no one after the unload", async () => {
    const { vector, witness: seen } = await witness("library/an-unload-revokes-every-holding-of-a-definition");

    expect(Object.keys(seen.observed)).toEqual(Object.keys(vector.then));
    expect(seen.observed).toEqual(vector.then);
  });
});

describe("library/a-binary-stays-open-while-a-holding-lives", () => {
  it("keeps the binary open past the unload until the last holding is released, then closes it", async () => {
    const { vector, witness: seen } = await witness("library/a-binary-stays-open-while-a-holding-lives");

    expect(Object.keys(seen.observed)).toEqual(Object.keys(vector.then));
    expect(seen.observed).toEqual(vector.then);
  });
});

describe("library/a-binary-closes-once-every-definition-service-is-released", () => {
  it("closes the binary only once the last definition service's holdings are released", async () => {
    const { vector, witness: seen } = await witness("library/a-binary-closes-once-every-definition-service-is-released");

    expect(Object.keys(seen.observed)).toEqual(Object.keys(vector.then));
    expect(seen.observed).toEqual(vector.then);
  });
});

describe("library/a-binary-with-no-holding-closes-at-the-unload", () => {
  it("closes the binary at the unload when nothing holds the definition", async () => {
    const { vector, witness: seen } = await witness("library/a-binary-with-no-holding-closes-at-the-unload");

    expect(Object.keys(seen.observed)).toEqual(Object.keys(vector.then));
    expect(seen.observed).toEqual(vector.then);
  });
});

describe("library/a-holding-ended-with-its-holder-closes-the-binary", () => {
  it("counts a holding the host ended by releasing or quarantining its holder towards the close", async () => {
    const { vector, witness: seen } = await witness("library/a-holding-ended-with-its-holder-closes-the-binary");

    expect(Object.keys(seen.observed)).toEqual(Object.keys(vector.then));
    expect(seen.observed).toEqual(vector.then);
  });
});

describe("library/a-held-bytes-answer-keeps-the-binary-open-past-the-last-holding", () => {
  it("closes the binary at the last definition release, since a bytes answer is copied and released before its call answers", async () => {
    const { vector, witness: seen } = await witness("library/a-held-bytes-answer-keeps-the-binary-open-past-the-last-holding");

    expect(Object.keys(seen.observed)).toEqual(Object.keys(vector.then));
    expect(seen.observed).toEqual({ ...vector.then, unloads: { equals: [0, 1, 1] } });
    expect(vector.then.unloads).toEqual({ equals: [0, 0, 1] });
  });
});
