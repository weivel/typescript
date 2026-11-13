import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ServiceRefusal, serviceOperations, type Config, type Paths, type Secrets } from "../../src/standard/index.ts";

const servicesHeader = readFileSync(join(import.meta.dirname, "..", "..", "siblings", "standard", "include", "weivel", "services.h"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");

/** The operations a definition struct of services.h carries: its function pointers, its releases aside. */
function headerOperations(struct: string): string[] {
  const body = new RegExp(String.raw`typedef struct ${struct} \{([\s\S]*?)\} ${struct};`).exec(servicesHeader)?.[1];
  if (body === undefined) {
    throw new Error(`services.h declares no ${struct}`);
  }
  return [...body.matchAll(/\(\s*\*\s*(\w+)\s*\)\s*\(/g)].map((match) => match[1]!).filter((name) => !name.startsWith("release_"));
}

type Unlisted<Definition, Listed extends readonly PropertyKey[]> = Exclude<keyof Definition, Listed[number]>;
type NothingUnlisted<Definition, Listed extends readonly PropertyKey[]> = [Unlisted<Definition, Listed>] extends [never] ? true : false;

const everyOperationListed: [
  NothingUnlisted<Config, typeof serviceOperations.config>,
  NothingUnlisted<Secrets, typeof serviceOperations.secrets>,
  NothingUnlisted<Paths, typeof serviceOperations.paths>,
] = [true, true, true];

describe("the config, secrets and paths services", () => {
  it("carry exactly the operations services.h defines, by its names, in its order", () => {
    expect(serviceOperations.config).toEqual(headerOperations("weivel_standard_config"));
    expect(serviceOperations.secrets).toEqual(headerOperations("weivel_standard_secrets"));
    expect(serviceOperations.paths).toEqual(headerOperations("weivel_standard_paths"));
    expect(everyOperationListed).toEqual([true, true, true]);
  });

  it("decline with the detail and the fix services.h's refusal carries", () => {
    const refusal = new ServiceRefusal("the settings file is read-only", "make the settings file writable");

    expect(refusal).toBeInstanceOf(Error);
    expect([refusal.detail, refusal.fix, refusal.message]).toEqual([
      "the settings file is read-only",
      "make the settings file writable",
      "the settings file is read-only",
    ]);
  });
});
