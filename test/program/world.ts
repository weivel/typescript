import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { sharedLibraryFileName } from "../../src/core/index.ts";
import { witnessHostVector, type HostProgramRun, type HostWitness, type LayerVector } from "../../src/conformance/index.ts";
import { coreLibraryPath } from "../real-core.ts";
import { standardLibraryPath } from "../real-standard.ts";

/** The kit's `stub-host`, which `scripts/native.ts` builds into `native/test/stub-host/` beside its `library.json`. */
export const stubHostDirectory = join(import.meta.dirname, "..", "..", "native", "test", "stub-host");
export const stubHostLibraryPath = join(stubHostDirectory, sharedLibraryFileName("stub-host"));

/** A host vector's waits run up to LAYER.md's 30-second bound, so its test is given a little more. */
export const hostTestTimeout = 35_000;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A fresh directory, removed after the test. */
export function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "weivel-program-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** A copy of `stub-host` in a directory of its own, `library.json` beside it holding `declaration`. */
export function stubHostCopy(declaration: unknown): string {
  const directory = temporaryDirectory();
  const binary = join(directory, sharedLibraryFileName("stub-host"));
  copyFileSync(stubHostLibraryPath, binary);
  writeFileSync(join(directory, "library.json"), JSON.stringify(declaration));
  return binary;
}

/** A `host` vector built in a test, in the kit's shape. */
export function hostVector(id: string, given: Record<string, unknown>): LayerVector {
  return { id, op: "host", covers: "host", given, then: {} };
}

/** Runs `vector` against `stub-host`, in process unless `run` says otherwise. */
export function witness(vector: LayerVector, run?: HostProgramRun): Promise<HostWitness> {
  return witnessHostVector(vector, { stubHostLibraryPath, coreLibraryPath, standardLibraryPath, ...(run === undefined ? {} : { run }) });
}
