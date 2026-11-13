import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLayerVectors, unwitnessedVectorIds } from "../../src/conformance/index.ts";
import { describedNames, layerVectorDirectory } from "./kit.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A copy of the kit's layer vectors with one more, `extraId`, that no test names. */
function vectorsWithOneMore(extraId: string): string {
  const directory = mkdtempSync(join(tmpdir(), "weivel-layer-vectors-"));
  temporaryDirectories.push(directory);
  cpSync(layerVectorDirectory, directory, { recursive: true });
  mkdirSync(join(directory, "nested", "deeper"), { recursive: true });
  writeFileSync(join(directory, `${extraId}.json`), JSON.stringify({ id: extraId, op: "want", given: {}, then: {} }));
  return directory;
}

describe("the layer suite", () => {
  it("names every layer vector of the pinned kit in a describe", () => {
    expect(readLayerVectors(layerVectorDirectory).length).toBeGreaterThan(0);
    expect(unwitnessedVectorIds(layerVectorDirectory, describedNames())).toEqual([]);
  });

  it("finds a vector no test names, however deep it sits", () => {
    const directory = vectorsWithOneMore("nested/deeper/a-vector-no-test-names");

    expect(unwitnessedVectorIds(directory, describedNames())).toEqual(["nested/deeper/a-vector-no-test-names"]);
  });

  it("refuses a vector whose id is not its path", () => {
    const directory = vectorsWithOneMore("nested/deeper/misnamed");
    writeFileSync(join(directory, "nested", "deeper", "misnamed.json"), JSON.stringify({ id: "elsewhere", op: "want", given: {}, then: {} }));

    expect(() => readLayerVectors(directory)).toThrow(/names itself elsewhere/);
  });
});
