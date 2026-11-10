import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sibling } from "../../../scripts/sibling.mjs";
import type { LibraryPin } from "../library/index.js";

const ECHO_DECLARATION = readFileSync(join(sibling("model"), "test", "fixtures", "echo.library.json"));

/**
 * The neutral fixture library, as released by `weivel/bindings`, pinned by digest.
 *
 * @implNote The v0.1.1 release still carries a declaration in the old shape, which no host now
 * accepts, so the declaration is pinned from the model's fixture and staged by `stagedCache`. Only
 * the binaries are downloaded from the release; pin the next release's own `library.json` here.
 */
export const ECHO_PIN: LibraryPin = {
  repository: "weivel/bindings",
  tag: "v0.1.1",
  sha256: {
    "library.json": createHash("sha256").update(ECHO_DECLARATION).digest("hex"),
    "linux-x64": "98cfd1f23800a3335a71cbf93f720baf8507e6ae1b257ef5654d7296852c41b9",
    "win32-x64": "ced2da158d9b52486ad5112c2f5d8a286f21a807f612309b7dcb2c12b1d273e3",
  },
};

/** A fresh cache holding the echo declaration `ECHO_PIN` names, so acquiring it downloads only the binary. */
export function stagedCache(prefix: string): string {
  const cache = mkdtempSync(join(tmpdir(), prefix));
  const directory = join(cache, ...ECHO_PIN.repository.split("/"), ECHO_PIN.tag);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "library.json"), ECHO_DECLARATION);
  return cache;
}
