import { describe, expect, it } from "vitest";
import { parseDeclaration } from "./declaration.js";
import type { LibraryDeclaration, LibraryFunction } from "./declaration.js";

const CONTEXTUAL: LibraryFunction = {
  name: "contextual",
  symbol: "echo_echo",
  kind: "json",
  argument: {},
  result: true,
  context: ["environment", "home", "arguments"],
};

/**
 * @implNote Never called: `tsc -p tsconfig.test.json` checks it before the tests run, so a type
 * that stops following library.schema.json leaves an expected error unused and fails the run.
 */
export function typedAsTheSchemaDeclares(): LibraryFunction[] {
  return [
    // @ts-expect-error "cwd" is not a fact the schema lists
    { ...CONTEXTUAL, context: ["cwd"] },
    // @ts-expect-error "bytes" is not a kind the schema lists
    { ...CONTEXTUAL, kind: "bytes" },
    // @ts-expect-error result is required
    { name: "a", symbol: "a", kind: "json", argument: {} },
    // @ts-expect-error the schema forbids a property it does not define
    { ...CONTEXTUAL, extra: 1 },
    { name: "a", symbol: "a", kind: "json", argument: false, result: {} },
  ];
}

describe("LibraryDeclaration", () => {
  it("reads a function's declared context", () => {
    const declaration: LibraryDeclaration = {
      id: "echo",
      version: "0.1.0",
      binary: "echo",
      release: "echo_release",
      services: [{ id: "echo", functions: [CONTEXTUAL] }],
    };
    expect(parseDeclaration(JSON.stringify(declaration)).services[0].functions[0].context).toEqual(["environment", "home", "arguments"]);
  });
});
