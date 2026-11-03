import { describe, expect, it } from "vitest";
import type { InstallMethodDetectAnswer, InstallMethodOperationAnswer } from "./index.js";
import { checkInstallMethodAnswer } from "./install-method.js";

const installed: InstallMethodDetectAnswer = { installed: true, version: "1.2.3" };
const refusal: InstallMethodOperationAnswer = { ok: false, detail: "no network", fix: "connect and retry" };

function pathsOf(definition: Parameters<typeof checkInstallMethodAnswer>[0], value: unknown): string[] {
  return checkInstallMethodAnswer(definition, value).map((issue) => issue.path);
}

describe("checkInstallMethodAnswer", () => {
  it("accepts a detect answer and names the missing member", () => {
    expect(checkInstallMethodAnswer("detectAnswer", installed)).toEqual([]);
    expect(checkInstallMethodAnswer("detectAnswer", { installed: false })).toEqual([]);
    expect(pathsOf("detectAnswer", { version: "1" })).toEqual(["installed"]);
    expect(pathsOf("detectAnswer", { installed: "yes" })).toEqual(["installed"]);
  });

  it("accepts a success and a refusal for an operation", () => {
    expect(checkInstallMethodAnswer("operationAnswer", { ok: true })).toEqual([]);
    expect(checkInstallMethodAnswer("operationAnswer", refusal)).toEqual([]);
  });

  it("refuses an operation answer that is neither", () => {
    expect(pathsOf("operationAnswer", { ok: false, detail: "x" }).length).toBeGreaterThan(0);
    expect(pathsOf("operationAnswer", {}).length).toBeGreaterThan(0);
  });
});
