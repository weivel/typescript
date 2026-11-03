import { describe, expect, it } from "vitest";
import { answer } from "./answer.js";

const INSTALL_METHOD = "https://weivel.github.io/model/install-method.schema.json";
const UI_DATA = "https://weivel.github.io/model/ui-data.schema.json";

describe("the answer op", () => {
  it("answers an install-method definition", () => {
    expect(answer({ schema: INSTALL_METHOD, definition: "detectAnswer", value: { installed: true } })).toEqual({ valid: true, paths: [] });
    expect(answer({ schema: INSTALL_METHOD, definition: "detectAnswer", value: { version: "1" } })).toEqual({ valid: false, paths: ["installed"] });
  });

  it("answers a ui-data component", () => {
    expect(answer({ schema: UI_DATA, definition: "table", value: { items: [{ id: "a", label: "A" }] } })).toEqual({ valid: true, paths: [] });
    expect(answer({ schema: UI_DATA, definition: "list", value: { items: [{ label: "x" }] } })).toEqual({ valid: false, paths: ["items[0].id"] });
  });

  it("refuses a schema or definition it does not know", () => {
    expect(() => answer({ schema: "https://example.test/x.json", definition: "a", value: {} })).toThrow();
    expect(() => answer({ schema: INSTALL_METHOD, definition: "nope", value: {} })).toThrow();
  });
});
