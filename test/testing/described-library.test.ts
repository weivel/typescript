import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describedLibrary, setVariables } from "../../src/testing/index.ts";
import { coreLibraryPath } from "../real-core.ts";
import { describedLibraryPath } from "../host/world.ts";

const SET_VARIABLE = "WEIVEL_VARIABLES_TEST_SET";
const UNSET_VARIABLE = "WEIVEL_VARIABLES_TEST_UNSET";
const fixtureDirectory = join(import.meta.dirname, "..", "..", "siblings", "standard", "test", "described");

const folders: string[] = [];

/** A folder holding the standard's described test library beside the declaration `declaration` is written as. */
function libraryFolder(declaration: string): string {
  const directory = mkdtempSync(join(tmpdir(), "described-library-"));
  folders.push(directory);
  copyFileSync(describedLibraryPath, join(directory, basename(describedLibraryPath)));
  writeFileSync(join(directory, "library.json"), declaration);
  return directory;
}

afterEach(() => {
  delete process.env[SET_VARIABLE];
  delete process.env[UNSET_VARIABLE];
  for (const directory of folders.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("describedLibrary", () => {
  it("binds a described service from its folder, its operations callable", async () => {
    const library = describedLibrary(libraryFolder(readFileSync(join(fixtureDirectory, "library.json"), "utf8")), { coreLibraryPath });
    try {
      const mirror = library.described.get("described-mirror");
      expect(mirror).toBeDefined();
      const answer = (await mirror!.reflect!({ sample: { label: "seen" } })) as { sample: { label: string } };
      expect(answer.sample.label).toBe("seen");
    } finally {
      await library.close();
    }
  });

  it("names the declaration the standard refuses", () => {
    const directory = libraryFolder("{}");
    expect(() => describedLibrary(directory, { coreLibraryPath })).toThrow(join(directory, "library.json"));
  });
});

describe("setVariables", () => {
  it("sets each variable, then restores a set one and deletes an unset one", () => {
    process.env[SET_VARIABLE] = "before";
    delete process.env[UNSET_VARIABLE];
    const restore = setVariables({ [SET_VARIABLE]: "during", [UNSET_VARIABLE]: "during" });
    expect(process.env[SET_VARIABLE]).toBe("during");
    expect(process.env[UNSET_VARIABLE]).toBe("during");
    restore();
    expect(process.env[SET_VARIABLE]).toBe("before");
    expect(UNSET_VARIABLE in process.env).toBe(false);
  });
});
