import { describe, expect, it } from "vitest";
import { assertManifest, isPluginError, validateManifest } from "../../src/engine/index.js";

describe("manifest validation", () => {
  it("accepts an unknown field inside a consumed service object", () => {
    const manifest = { id: "a", api: 2, services: { consumes: [{ id: "x", reticulation: 3 }] } };
    expect(validateManifest(manifest)).toEqual([]);
  });

  it("returns the very object it was given when valid", () => {
    const manifest = { id: "a", api: 2 };
    expect(assertManifest(manifest)).toBe(manifest);
  });

  it("names every failing path in the refusal it throws", () => {
    const manifest = { id: "Bad Id", api: "one" };
    let thrown: unknown;
    try {
      assertManifest(manifest);
    } catch (error) {
      thrown = error;
    }
    expect(isPluginError(thrown)).toBe(true);
    const failure = thrown as { pluginId: string; detail: string; fix: string };
    expect(failure.pluginId).toBe("Bad Id");
    expect(failure.detail).toContain("id");
    expect(failure.detail).toContain("api");
    expect(failure.fix.length).toBeGreaterThan(0);
  });

  it("attributes a refusal to the manifest when it declares no string id", () => {
    expect(() => assertManifest({ api: 2 })).toThrow(/\[manifest\]/);
  });

  it("skips the bare-id rule without a well-known list and applies it to an empty one", () => {
    const manifest = { id: "a", api: 2, services: { provides: ["routing"] } };
    expect(validateManifest(manifest)).toEqual([]);
    expect(validateManifest(manifest, []).map((issue) => issue.path)).toEqual(["services.provides[0]"]);
  });

  it("reports a service listed as a string and as an object at the second occurrence", () => {
    const manifest = { id: "a", api: 2, services: { consumes: ["x", { id: "x" }] } };
    expect(validateManifest(manifest).map((issue) => issue.path)).toEqual(["services.consumes[1]"]);
  });
});
