import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { sharedLibraryFileName } from "../src/core/library-file.ts";

interface BuiltTarget {
  target: string;
  outputName: string;
  destination: string;
}

interface NativeLibrary {
  sibling: string;
  targets: BuiltTarget[];
  configureDefinitions: string[];
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const siblingsDirectory = join(repositoryRoot, "siblings");
const buildDirectory = join(repositoryRoot, "build");
const nativeDirectory = join(repositoryRoot, "native");
const testLibraryDirectory = join(nativeDirectory, "test");

const nativeLibraries: NativeLibrary[] = [
  {
    sibling: "core",
    targets: [
      { target: "weivel_core_shared", outputName: "weivel_core", destination: nativeDirectory },
      { target: "echo", outputName: "echo", destination: testLibraryDirectory },
    ],
    configureDefinitions: [],
  },
  {
    sibling: "standard",
    targets: [{ target: "weivel_standard_shared", outputName: "weivel_standard", destination: nativeDirectory }],
    configureDefinitions: [`-DWEIVEL_CORE_SOURCE_DIR=${join(siblingsDirectory, "core")}`],
  },
];

function isMissingProgram(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function runCmake(cmakeArguments: string[]): void {
  try {
    execFileSync("cmake", cmakeArguments, { stdio: "inherit" });
  } catch (error) {
    if (isMissingProgram(error)) {
      throw new Error("cmake is not on the PATH. Building the core and the standard needs CMake 3.15 or later and a C compiler.");
    }
    throw error;
  }
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
  runCmake([
    "-S",
    requireSibling(library.sibling),
    "-B",
    libraryBuildDirectory,
    "-DCMAKE_BUILD_TYPE=Release",
    ...library.configureDefinitions,
  ]);
  const targetNames = library.targets.map((built) => built.target);
  runCmake(["--build", libraryBuildDirectory, "--config", "Release", "--target", ...targetNames, "--parallel"]);
  for (const built of library.targets) {
    const fileName = sharedLibraryFileName(built.outputName);
    copyFileSync(findBuiltLibrary(libraryBuildDirectory, fileName), join(built.destination, fileName));
  }
}

mkdirSync(testLibraryDirectory, { recursive: true });
for (const library of nativeLibraries) {
  buildNativeLibrary(library);
}
