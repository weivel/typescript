import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { sharedLibraryFileName } from "../src/core/library-file.ts";

interface NativeLibrary {
  sibling: string;
  target: string;
  outputName: string;
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const siblingsDirectory = join(repositoryRoot, "siblings");
const buildDirectory = join(repositoryRoot, "build");
const nativeDirectory = join(repositoryRoot, "native");

const nativeLibraries: NativeLibrary[] = [
  { sibling: "core", target: "weivel_core_shared", outputName: "weivel_core" },
  { sibling: "standard", target: "weivel_standard_shared", outputName: "weivel_standard" },
];

function runCmake(cmakeArguments: string[]): void {
  execFileSync("cmake", cmakeArguments, { stdio: "inherit" });
}

function requireSibling(sibling: string): string {
  const siblingDirectory = join(siblingsDirectory, sibling);
  if (!existsSync(join(siblingDirectory, "CMakeLists.txt"))) {
    throw new Error(
      `siblings/${sibling} is missing. CI checks it out from .weivel/repo.json; locally, link or clone ` +
        `the ${sibling} checkout there at the commit .weivel/repo.json pins.`,
    );
  }
  return siblingDirectory;
}

/** @implNote The standard's CMakeLists builds the core from its own `siblings/core`, so that is pointed at the core this repository pins. */
function linkStandardToPinnedCore(): void {
  const standardSiblings = join(requireSibling("standard"), "siblings");
  const standardCore = join(standardSiblings, "core");
  if (existsSync(standardCore)) {
    return;
  }
  mkdirSync(standardSiblings, { recursive: true });
  symlinkSync(requireSibling("core"), standardCore, "junction");
}

function findBuiltLibrary(libraryBuildDirectory: string, fileName: string): string {
  const candidates = [join(libraryBuildDirectory, "bin", "Release", fileName), join(libraryBuildDirectory, "bin", fileName)];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(`${fileName} was not built; looked for ${candidates.join(" and ")}`);
  }
  return found;
}

function buildNativeLibrary(library: NativeLibrary): void {
  const libraryBuildDirectory = join(buildDirectory, library.sibling);
  runCmake(["-S", requireSibling(library.sibling), "-B", libraryBuildDirectory, "-DCMAKE_BUILD_TYPE=Release"]);
  runCmake(["--build", libraryBuildDirectory, "--config", "Release", "--target", library.target, "--parallel"]);
  const fileName = sharedLibraryFileName(library.outputName);
  copyFileSync(findBuiltLibrary(libraryBuildDirectory, fileName), join(nativeDirectory, fileName));
}

mkdirSync(nativeDirectory, { recursive: true });
linkStandardToPinnedCore();
for (const library of nativeLibraries) {
  buildNativeLibrary(library);
}
