import { describe, expect, it } from "vitest";
import { readLayerVector } from "../../src/conformance/index.ts";
import { hostTestTimeout, witness } from "../program/world.ts";
import { layerVectorDirectory } from "./kit.ts";

interface HostThen {
  readonly record: { readonly equals: readonly string[] };
  readonly exit?: number;
  readonly exitsNonZero?: boolean;
}

/** Runs the kit's vector in process against `stub-host` and judges its record and exit code as LAYER.md states. */
async function judge(id: string): Promise<void> {
  const vector = readLayerVector(layerVectorDirectory, id);
  const then = vector.then as unknown as HostThen;

  const seen = await witness(vector);

  expect(seen.record).toEqual(then.record.equals);
  if (then.exitsNonZero === true) {
    expect(seen.exit).not.toBe(0);
  } else {
    expect(seen.exit).toBe(then.exit);
  }
}

describe("host/a-plugin-reads-its-own-scoped-config", () => {
  it("runs as the vector states", () => judge("host/a-plugin-reads-its-own-scoped-config"), hostTestTimeout);
});

describe("host/a-plugin-without-a-scope-is-offered-nothing", () => {
  it("runs as the vector states", () => judge("host/a-plugin-without-a-scope-is-offered-nothing"), hostTestTimeout);
});

describe("host/a-refused-scope-quarantines-that-plugin-alone", () => {
  it("runs as the vector states", () => judge("host/a-refused-scope-quarantines-that-plugin-alone"), hostTestTimeout);
});

describe("host/a-refused-start-calls-nothing-else", () => {
  it("runs as the vector states", () => judge("host/a-refused-start-calls-nothing-else"), hostTestTimeout);
});

describe("host/a-refused-started-still-stops", () => {
  it("runs as the vector states", () => judge("host/a-refused-started-still-stops"), hostTestTimeout);
});

describe("host/a-refused-tick-still-stops", () => {
  it("runs as the vector states", () => judge("host/a-refused-tick-still-stops"), hostTestTimeout);
});

describe("host/a-stop-request-stops-cleanly-while-a-tick-waits", () => {
  it("runs as the vector states", () => judge("host/a-stop-request-stops-cleanly-while-a-tick-waits"), hostTestTimeout);
});

describe("host/a-throwing-action-reaches-finished-as-a-failure", () => {
  it("runs as the vector states", () => judge("host/a-throwing-action-reaches-finished-as-a-failure"), hostTestTimeout);
});

describe("host/an-action-answering-nothing-reaches-finished-as-none", () => {
  it("runs as the vector states", () => judge("host/an-action-answering-nothing-reaches-finished-as-none"), hostTestTimeout);
});

describe("host/an-action-runs-and-its-result-reaches-finished", () => {
  it("runs as the vector states", () => judge("host/an-action-runs-and-its-result-reaches-finished"), hostTestTimeout);
});

describe("host/an-activation-that-throws-is-told-as-failed", () => {
  it("runs as the vector states", () => judge("host/an-activation-that-throws-is-told-as-failed"), hostTestTimeout);
});

describe("host/start-hands-its-arguments-and-activates-the-plan-in-order", () => {
  it("runs as the vector states", () => judge("host/start-hands-its-arguments-and-activates-the-plan-in-order"), hostTestTimeout);
});

describe("host/stop-answers-the-exit-code", () => {
  it("runs as the vector states", () => judge("host/stop-answers-the-exit-code"), hostTestTimeout);
});

describe("host/tick-is-called-at-each-time-it-answered", () => {
  it("runs as the vector states", () => judge("host/tick-is-called-at-each-time-it-answered"), hostTestTimeout);
});
