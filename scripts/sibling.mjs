import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function repositoryRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function isCheckout(directory) {
  return existsSync(join(directory, "package.json")) || existsSync(join(directory, ".git"));
}

/**
 * The absolute path of a sibling repository, found inside this repository first (CI checks them
 * out there) and beside it second (a local workspace).
 */
export function sibling(name, from = repositoryRoot()) {
  const inner = join(from, name);
  const outer = join(from, "..", name);
  if (isCheckout(inner)) return inner;
  if (isCheckout(outer)) return resolve(outer);
  throw new Error(`sibling "${name}" not found, tried ${inner} and ${resolve(outer)}`);
}
