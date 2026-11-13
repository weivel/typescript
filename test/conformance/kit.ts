import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const layerVectorDirectory = join(import.meta.dirname, "..", "..", "siblings", "conformance", "vectors", "layer");

const testDirectory = join(import.meta.dirname, "..");

function testFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return testFiles(path);
    }
    return entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

/** Every name a `describe` of this repo's tests gives, read from the test files' text. */
export function describedNames(directory = testDirectory): string[] {
  return testFiles(directory).flatMap((path) =>
    [...readFileSync(path, "utf8").matchAll(/\bdescribe\(\s*"([^"]+)"/g)].map((match) => match[1]!),
  );
}
