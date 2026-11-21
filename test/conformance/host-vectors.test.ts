import { describe, it } from "vitest";
import { readLayerVector } from "../../src/conformance/index.ts";
import { hostTestTimeout, judgeHostVector } from "../program/world.ts";
import { layerVectorDirectory } from "./kit.ts";

/** Runs the kit's vector in process against `stub-host` and judges it as LAYER.md states. */
function judge(id: string): Promise<void> {
  return judgeHostVector(readLayerVector(layerVectorDirectory, id));
}

describe("host/a-library-declaring-a-standard-id-makes-the-scope-unofferable", () => {
  it("runs as the vector states", () => judge("host/a-library-declaring-a-standard-id-makes-the-scope-unofferable"), hostTestTimeout);
});

describe("host/a-malformed-next-ends-the-run", () => {
  it("runs as the vector states", () => judge("host/a-malformed-next-ends-the-run"), hostTestTimeout);
});

describe("host/a-malformed-plan-loads-none-of-its-libraries", () => {
  it("runs as the vector states", () => judge("host/a-malformed-plan-loads-none-of-its-libraries"), hostTestTimeout);
});

describe("host/a-method-of-a-service-no-plugin-registered-reaches-finished-as-a-failure", () => {
  it("runs as the vector states", () => judge("host/a-method-of-a-service-no-plugin-registered-reaches-finished-as-a-failure"), hostTestTimeout);
});

describe("host/a-method-run-whose-plugin-was-not-activated-reaches-finished-as-a-failure", () => {
  it("runs as the vector states", () => judge("host/a-method-run-whose-plugin-was-not-activated-reaches-finished-as-a-failure"), hostTestTimeout);
});

describe("host/a-method-the-service-does-not-offer-reaches-finished-as-a-failure", () => {
  it("runs as the vector states", () => judge("host/a-method-the-service-does-not-offer-reaches-finished-as-a-failure"), hostTestTimeout);
});

describe("host/a-plan-library-that-will-not-load-still-stops", () => {
  it("runs as the vector states", () => judge("host/a-plan-library-that-will-not-load-still-stops"), hostTestTimeout);
});

describe("host/a-plan-naming-a-method-without-a-service-is-malformed", () => {
  it("runs as the vector states", () => judge("host/a-plan-naming-a-method-without-a-service-is-malformed"), hostTestTimeout);
});

describe("host/a-plan-naming-a-service-without-a-method-is-malformed", () => {
  it("runs as the vector states", () => judge("host/a-plan-naming-a-service-without-a-method-is-malformed"), hostTestTimeout);
});

describe("host/a-plan-naming-an-empty-service-is-malformed", () => {
  it("runs as the vector states", () => judge("host/a-plan-naming-an-empty-service-is-malformed"), hostTestTimeout);
});

describe("host/a-plugin-is-offered-no-scope-or-host-service", () => {
  it("runs as the vector states", () => judge("host/a-plugin-is-offered-no-scope-or-host-service"), hostTestTimeout);
});

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

describe("host/a-service-another-plugin-provides-reaches-finished-as-a-failure", () => {
  it("runs as the vector states", () => judge("host/a-service-another-plugin-provides-reaches-finished-as-a-failure"), hostTestTimeout);
});

describe("host/a-stop-request-during-activation-waits-for-started", () => {
  it("runs as the vector states", () => judge("host/a-stop-request-during-activation-waits-for-started"), hostTestTimeout);
});

describe("host/a-stop-request-during-an-action-waits-for-finished", () => {
  it("runs as the vector states", () => judge("host/a-stop-request-during-an-action-waits-for-finished"), hostTestTimeout);
});

describe("host/a-stop-request-stops-cleanly-while-a-tick-waits", () => {
  it("runs as the vector states", () => judge("host/a-stop-request-stops-cleanly-while-a-tick-waits"), hostTestTimeout);
});

describe("host/a-throwing-action-reaches-finished-as-a-failure", () => {
  it("runs as the vector states", () => judge("host/a-throwing-action-reaches-finished-as-a-failure"), hostTestTimeout);
});

describe("host/a-throwing-method-reaches-finished-as-a-failure", () => {
  it("runs as the vector states", () => judge("host/a-throwing-method-reaches-finished-as-a-failure"), hostTestTimeout);
});

describe("host/an-action-answering-nothing-reaches-finished-as-none", () => {
  it("runs as the vector states", () => judge("host/an-action-answering-nothing-reaches-finished-as-none"), hostTestTimeout);
});

describe("host/an-action-calls-a-method-of-a-service-its-plugin-provides", () => {
  it("runs as the vector states", () => judge("host/an-action-calls-a-method-of-a-service-its-plugin-provides"), hostTestTimeout);
});

describe("host/an-action-named-alone-runs-the-entrys-action-beside-a-provided-service", () => {
  it("runs as the vector states", () => judge("host/an-action-named-alone-runs-the-entrys-action-beside-a-provided-service"), hostTestTimeout);
});

describe("host/an-action-runs-and-its-result-reaches-finished", () => {
  it("runs as the vector states", () => judge("host/an-action-runs-and-its-result-reaches-finished"), hostTestTimeout);
});

describe("host/an-activation-that-throws-is-told-as-failed", () => {
  it("runs as the vector states", () => judge("host/an-activation-that-throws-is-told-as-failed"), hostTestTimeout);
});

describe("host/an-unreadable-manifest-is-refused-and-the-rest-activate", () => {
  it("runs as the vector states", () => judge("host/an-unreadable-manifest-is-refused-and-the-rest-activate"), hostTestTimeout);
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
