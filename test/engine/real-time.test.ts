import { describe, expect, it } from "vitest";
import { REAL_TIME } from "../../src/engine/index.js";

describe("REAL_TIME", () => {
  it("is frozen, so no caller can swap the clock every host defaults to", () => {
    expect(Object.isFrozen(REAL_TIME)).toBe(true);
  });
});
