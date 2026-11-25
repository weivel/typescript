import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bundleCommandLine } from "../../src/bundle/command-line.ts";
import { temporaryDirectory } from "../program/world.ts";

const bundlingTimeout = 60_000;
const repositoryRoot = join(import.meta.dirname, "..", "..");

afterEach(() => vi.restoreAllMocks());

function captureOutput(): { readonly out: string[]; readonly err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void out.push(line));
  vi.spyOn(console, "error").mockImplementation((line: string) => void err.push(line));
  return { out, err };
}

async function misuseOf(argv: readonly string[]): Promise<string> {
  const { err } = captureOutput();
  expect(await bundleCommandLine(argv)).toBe(2);
  return err.join("\n");
}

describe("weivel-bundle program", () => {
  it("writes the command line and the in-process module into the directory, one path per line", async () => {
    const directory = temporaryDirectory();
    const { out } = captureOutput();
    expect(await bundleCommandLine(["program", directory])).toBe(0);
    expect(out).toEqual([join(directory, "weivel-host.mjs"), join(directory, "weivel-host-in-process.mjs")]);
    out.forEach((path) => expect(existsSync(path)).toBe(true));
  }, bundlingTimeout);

  it("writes the two library paths it is given into the bundle", async () => {
    const directory = temporaryDirectory();
    captureOutput();
    expect(await bundleCommandLine(["program", directory, "--core", "/libs/core.so", "--standard", "/libs/standard.so"])).toBe(0);
    const text = readFileSync(join(directory, "weivel-host.mjs"), "utf8");
    expect(text).toContain("/libs/core.so");
    expect(text).toContain("/libs/standard.so");
  }, bundlingTimeout);

  it("refuses --core without --standard", async () => {
    expect(await misuseOf(["program", temporaryDirectory(), "--core", "/libs/core.so"])).toContain("usage: weivel-bundle");
  });

  it("refuses --standard without --core", async () => {
    expect(await misuseOf(["program", temporaryDirectory(), "--standard", "/libs/standard.so"])).toContain("usage: weivel-bundle");
  });
});

describe("weivel-bundle plugin", () => {
  it("writes the entry as one .mjs file and prints its path", async () => {
    const directory = temporaryDirectory();
    const entry = join(directory, "greeter.ts");
    writeFileSync(entry, `export const greeting: string = "hello";\n`);
    const outputDirectory = join(directory, "out");
    mkdirSync(outputDirectory);
    const { out } = captureOutput();
    expect(await bundleCommandLine(["plugin", entry, outputDirectory])).toBe(0);
    expect(out).toEqual([join(outputDirectory, "greeter.mjs")]);
    expect(existsSync(out[0]!)).toBe(true);
  }, bundlingTimeout);

  it("exits 1 with the error when the entry cannot be bundled", async () => {
    const { err } = captureOutput();
    expect(await bundleCommandLine(["plugin", join(temporaryDirectory(), "missing.ts"), temporaryDirectory()])).toBe(1);
    expect(err.join("\n")).not.toBe("");
  });
});

describe("weivel-bundle misuse", () => {
  it.each([
    ["no word", []],
    ["an unknown word", ["frobnicate"]],
    ["program without a directory", ["program"]],
    ["plugin without an output directory", ["plugin", "entry.ts"]],
    ["program with an unknown flag", ["program", "out", "--bogus", "x"]],
    ["program with a flag lacking its value", ["program", "out", "--core"]],
  ])("%s exits 2 with the usage line", async (_name, argv) => {
    expect(await misuseOf(argv)).toContain("usage: weivel-bundle");
  });
});

describe("the built dist/bundle/bin.js", () => {
  it("writes the program when run under node", () => {
    const outputRoot = temporaryDirectory();
    const compiledRoot = join(repositoryRoot, "build", "bundle-bin-test");
    const compilerOptions = ["--rootDir", join(repositoryRoot, "src"), "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--strict", "--skipLibCheck", "--types", "node", "--outDir", compiledRoot];
    const entries = [join(repositoryRoot, "src", "bundle", "bin.ts"), join(repositoryRoot, "src", "program", "bin.ts")];
    execFileSync(process.execPath, [join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"), ...entries, ...compilerOptions], { cwd: repositoryRoot });
    const output = execFileSync(process.execPath, [join(compiledRoot, "bundle", "bin.js"), "program", outputRoot], { encoding: "utf8" });
    expect(output.trim().split(/\r?\n/)).toEqual([join(outputRoot, "weivel-host.mjs"), join(outputRoot, "weivel-host-in-process.mjs")]);
    expect(existsSync(join(outputRoot, "weivel-host.mjs"))).toBe(true);
  }, bundlingTimeout);
});
