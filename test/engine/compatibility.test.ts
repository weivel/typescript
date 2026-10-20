import { describe, expect, it } from "vitest";
import { compatibility, factsOf } from "../../src/engine/index.js";

describe("compatibility", () => {
  it("accepts a manifest naming a language and an implementation the host has no notion of", () => {
    const manifest = { id: "thing", api: 1, languages: ["java"], implementation: "jvm" };
    expect(compatibility({ applications: ["claude"], api: 2 }, factsOf(manifest))).toBeNull();
  });
});
