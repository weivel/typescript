import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { sharedLibraryFileName } from "../src/core/index.ts";
import { loadStandard, type Standard } from "../src/standard/index.ts";

export const standardLibraryPath = join(import.meta.dirname, "..", "native", sharedLibraryFileName("weivel_standard"));

/** The standard built in native/. */
export function realStandard(): Standard {
  return loadStandard(standardLibraryPath);
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A fresh directory holding `files` (name to text), removed after the test. */
export function directoryWith(files: Record<string, string> = {}): string {
  const directory = mkdtempSync(join(tmpdir(), "weivel-standard-"));
  temporaryDirectories.push(directory);
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(directory, name), text);
  }
  return directory;
}
