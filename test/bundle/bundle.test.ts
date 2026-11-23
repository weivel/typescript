import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { bundlePlugin, bundleProgram } from "../../src/bundle/index.ts";
import { failedRunExit } from "../../src/program/index.ts";
import { bundleRelocatedProgram } from "../program/child.ts";
import { temporaryDirectory } from "../program/world.ts";

const sourceDirectory = join(import.meta.dirname, "..", "..", "src");

function specifiersOf(path: string): string[] {
  const text = readFileSync(path, "utf8");
  return [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)"([^"]+)"/g)].map((match) => match[1]!);
}

/**
 * Every bare specifier the modules reachable from `entry` import, following its relative imports through the source.
 *
 * @implNote A relative specifier naming no source file is text inside a module, such as the program entry the bundler
 * generates, and is not followed; tsc refuses a real import of a missing file.
 */
function bareImportsReachableFrom(entry: string): Set<string> {
  const bare = new Set<string>();
  const seen = new Set<string>();
  const pending = [entry];
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    if (seen.has(path) || !existsSync(path)) {
      continue;
    }
    seen.add(path);
    for (const specifier of specifiersOf(path)) {
      if (specifier.startsWith(".")) {
        pending.push(resolve(dirname(path), specifier).replace(/\.js$/, ".ts"));
      } else {
        bare.add(specifier);
      }
    }
  }
  return bare;
}

describe("the bundle entry's dependency", () => {
  it("is imported from ./bundle", () => {
    expect(bareImportsReachableFrom(join(sourceDirectory, "bundle", "index.ts"))).toContain("esbuild");
  });

  it("is not loaded by importing ./host or ./program", () => {
    for (const entry of [join(sourceDirectory, "host", "index.ts"), join(sourceDirectory, "program", "index.ts")]) {
      const reachable = bareImportsReachableFrom(entry);
      expect(reachable).toContain("koffi");
      expect(reachable).not.toContain("esbuild");
    }
  });
});

describe("bundlePlugin", () => {
  it("writes the entry and what it imports as one module that runs without them", async () => {
    const sources = temporaryDirectory();
    writeFileSync(join(sources, "greeting.js"), `export const greeting = "hello from a module beside the entry";\n`);
    writeFileSync(join(sources, "entry.js"), `import { greeting } from "./greeting.js";\nexport default { activate() { return greeting; } };\n`);

    const bundled = await bundlePlugin(join(sources, "entry.js"), temporaryDirectory());
    rmSync(sources, { recursive: true, force: true });
    const plugin = (await import(pathToFileURL(bundled).href)) as { default: { activate(): string } };

    expect(plugin.default.activate()).toBe("hello from a module beside the entry");
  });
});

/**
 * The runtime options that hold a bare import to the `node_modules` lookup Node makes.
 *
 * @implNote Bun installs a bare import from npm into its global cache when no `node_modules` lies at or above the
 * importing file, unless `--no-install` is given, so without it a bundle with nothing above it still finds koffi.
 */
const resolvingFromNodeModulesAlone: readonly string[] = "Bun" in globalThis ? ["--no-install"] : [];

/** Runs `program` with no arguments and answers its exit code and what it wrote to stderr. */
function runWithoutArguments(program: string, runtimeOptions: readonly string[] = []): { exit: number; standardError: string } {
  try {
    execFileSync(process.execPath, [...runtimeOptions, program], { stdio: ["ignore", "ignore", "pipe"] });
    return { exit: 0, standardError: "" };
  } catch (error) {
    const failed = error as { status: number; stderr: Buffer };
    return { exit: failed.status, standardError: failed.stderr.toString() };
  }
}

describe("bundleProgram", () => {
  it("writes a command line that runs from a directory of its own and answers its usage without a host library", async () => {
    const relocated = await bundleRelocatedProgram();
    try {
      const ran = runWithoutArguments(relocated.program);

      expect(ran.exit).toBe(failedRunExit);
      expect(ran.standardError).toContain("usage: weivel-host <host library>");
    } finally {
      relocated.remove();
    }
  });

  it("leaves koffi a bare import, resolved from a node_modules at or above the bundle", async () => {
    const bundled = await bundleProgram(temporaryDirectory());

    const ran = runWithoutArguments(bundled.commandLine, resolvingFromNodeModulesAlone);

    for (const file of [bundled.commandLine, bundled.inProcess]) {
      const text = readFileSync(file, "utf8");
      expect(text).toMatch(/from\s*"koffi"/);
      expect(text).not.toContain("koffi.node");
    }
    expect(ran.exit).not.toBe(0);
    expect(ran.standardError).toContain("Cannot find package 'koffi'");
  });
});
