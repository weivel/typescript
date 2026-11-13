import { mkdtempSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { readLayerVector, witnessLayerVector, type LayerVector } from "../../src/conformance/index.ts";
import { coreLibraryPath } from "../real-core.ts";
import { layerVectorDirectory } from "./kit.ts";

const options = { coreLibraryPath };

function kitVector(id: string): LayerVector {
  return readLayerVector(layerVectorDirectory, id);
}

function withThen(vector: LayerVector, then: Record<string, unknown>): LayerVector {
  return { ...vector, then: { ...vector.then, ...then } };
}

const consumeId = "consume/a-throwing-listener-does-not-silence-the-others";
const wantId = "want/a-registration-at-the-deadline-loses";
const lifecycleId = "lifecycle/a-release-deactivates-then-releases-then-forgets";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdtempSync: vi.fn(actual.mkdtempSync), writeFileSync: vi.fn(actual.writeFileSync) };
});

describe("the layer driver", () => {
  it("registers each vector's plugins as manifest values, writing no file", async () => {
    vi.mocked(mkdtempSync).mockClear();
    vi.mocked(writeFileSync).mockClear();

    await witnessLayerVector(kitVector(consumeId), options);

    expect(vi.mocked(mkdtempSync)).not.toHaveBeenCalled();
    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
  });

  it("fails a then field it does not witness", async () => {
    await expect(witnessLayerVector(withThen(kitVector(consumeId), { echoed: { equals: [] } }), options)).rejects.toThrow(
      /then\.echoed, which this driver does not witness/,
    );
    await expect(witnessLayerVector(withThen(kitVector(wantId), { servedBy: null }), options)).rejects.toThrow(
      /then\.servedBy, which this driver does not witness/,
    );
  });

  it("fails a step kind it does not drive", async () => {
    const vector = kitVector(consumeId);
    const steps = [...(vector.given.steps as object[]), { plugin: "calendar", quarantine: true }];

    await expect(witnessLayerVector({ ...vector, given: { ...vector.given, steps } }, options)).rejects.toThrow(
      /names 0 actions/,
    );
  });

  it("fails a key a step carries beside its action", async () => {
    const vector = kitVector(consumeId);
    const steps = [{ plugin: "calendar", provide: "screens", throws: true }];

    await expect(witnessLayerVector({ ...vector, given: { ...vector.given, steps } }, options)).rejects.toThrow(
      /carries throws, which this driver does not drive/,
    );
  });

  it("fails a given field and an op it does not drive", async () => {
    const vector = kitVector(wantId);

    await expect(witnessLayerVector({ ...vector, given: { ...vector.given, retries: 2 } }, options)).rejects.toThrow(
      /carries retries/,
    );
    await expect(witnessLayerVector({ ...vector, op: "scope" }, options)).rejects.toThrow(/the op scope/);
  });

  it("answers a then that differs from the run with what the run showed, so the comparison fails", async () => {
    const seen = await witnessLayerVector(withThen(kitVector(wantId), { atMillis: { equals: 999 }, settled: true }), options);

    expect(seen.observed.atMillis).toEqual({ equals: 1000 });
    expect(seen.observed.settled).toBe(false);
  });

  it("answers a reach a plugin was refused and the first refusal a step met", async () => {
    const vector = kitVector(consumeId);
    const steps = [
      { plugin: "agenda", watch: "extras" },
      { plugin: "calendar", provide: "screens" },
      { plugin: "calendar", provide: "screens" },
    ];

    const seen = await witnessLayerVector({ ...vector, given: { ...vector.given, steps } }, options);

    expect(seen.observed.reported).toEqual({ equals: [["agenda", "extras"]] });
    expect(seen.observed.refusal).toMatchObject({ code: "provided_twice", hasFix: true });
  });

  it("times a want out at its own deadline when nothing registers, though time runs on to the horizon", async () => {
    const vector = kitVector(wantId);
    const never = { ...vector, given: { ...vector.given, registerAtMillis: null } };

    const seen = await witnessLayerVector(never, options);

    expect(seen.observed).toEqual({ ...vector.then, atMillis: { equals: 1000 } });
  });

  it("serves a want whose registration comes before its deadline, at the registration's time", async () => {
    const vector = kitVector(wantId);
    const early = { ...vector, given: { ...vector.given, registerAtMillis: 999 } };

    const seen = await witnessLayerVector(early, options);

    expect(seen.observed).toEqual({ settled: true, timedOut: false, atMillis: { equals: 999 }, refusal: null });
  });

  it("answers a lifecycle trace pair the run breaks as broken, so the comparison fails", async () => {
    const vector = kitVector(lifecycleId);
    const reversed = { before: [["missed agenda calendar:events", "deactivate calendar"]] };

    const seen = await witnessLayerVector(withThen(vector, { trace: reversed }), options);

    expect(seen.observed.trace).not.toEqual(reversed);
    expect((seen.observed.trace as { before: string[][] }).before[0]![2]).toMatch(/^not in that order/);
  });

  it("fails a lifecycle action and a step it does not drive", async () => {
    const vector = kitVector(lifecycleId);
    const given = vector.given as { plugins: Record<string, unknown>[]; steps: unknown[] };
    const plugins = [{ ...given.plugins[0]!, activate: [{ provide: "screens" }] }, given.plugins[1]!];

    await expect(witnessLayerVector({ ...vector, given: { ...given, plugins } }, options)).rejects.toThrow(/names 0 actions/);
    await expect(witnessLayerVector({ ...vector, given: { ...given, steps: [{ quarantine: "calendar" }] } }, options)).rejects.toThrow(
      /names 0 actions/,
    );
  });
});
