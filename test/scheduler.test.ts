import { describe, expect, it } from "vitest";
import { NEVER } from "../src/index.js";

describe("NEVER", () => {
  it("never runs a scheduled task", async () => {
    let ran = false;
    NEVER.schedule(() => {
      ran = true;
    }, 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ran).toBe(false);
  });

  it("returns a disposer that may be called twice", () => {
    const dispose = NEVER.schedule(() => {}, 0);
    expect(() => {
      dispose();
      dispose();
    }).not.toThrow();
  });
});
