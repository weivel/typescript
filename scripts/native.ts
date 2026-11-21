import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { executableFileName, sharedLibraryFileName } from "../src/core/library-file.ts";

interface BuiltTarget {
  target: string;
  /** The file CMake writes for the target, under the build's `bin`. */
  fileName: string;
  destination: string;
}

interface NativeLibrary {
  /** The CMake project, a path under `siblings/`. */
  sibling: string;
  /** The build directory's name under `build/`, kept short since MSBuild's paths below it are long. */
  buildName: string;
  targets: BuiltTarget[];
  configureDefinitions: string[];
  /** Files of the project copied beside what it built, each from its path in the project to a destination. */
  companions: { source: string; destination: string }[];
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const siblingsDirectory = join(repositoryRoot, "siblings");
const buildDirectory = join(repositoryRoot, "build");
const nativeDirectory = join(repositoryRoot, "native");
const testLibraryDirectory = join(nativeDirectory, "test");
const stubHostDirectory = join(testLibraryDirectory, "stub-host");

const nativeLibraries: NativeLibrary[] = [
  {
    sibling: "core",
    buildName: "core",
    targets: [
      { target: "weivel_core_shared", fileName: sharedLibraryFileName("weivel_core"), destination: nativeDirectory },
      { target: "echo", fileName: sharedLibraryFileName("echo"), destination: testLibraryDirectory },
    ],
    configureDefinitions: [],
    companions: [],
  },
  {
    sibling: "standard",
    buildName: "standard",
    targets: [
      { target: "weivel_standard_shared", fileName: sharedLibraryFileName("weivel_standard"), destination: nativeDirectory },
      {
        target: "weivel_standard_described",
        fileName: sharedLibraryFileName("weivel_standard_described"),
        destination: testLibraryDirectory,
      },
      { target: "layouts", fileName: executableFileName("layouts"), destination: testLibraryDirectory },
    ],
    configureDefinitions: [`-DWEIVEL_CORE_SOURCE_DIR=${join(siblingsDirectory, "core")}`],
    companions: [],
  },
  {
    sibling: join("conformance", "test", "stub-host"),
    buildName: "sh",
    targets: [{ target: "stub-host", fileName: sharedLibraryFileName("stub-host"), destination: stubHostDirectory }],
    configureDefinitions: [
      `-DWEIVEL_STANDARD_SOURCE_DIR=${join(siblingsDirectory, "standard")}`,
      `-DWEIVEL_CORE_SOURCE_DIR=${join(siblingsDirectory, "core")}`,
    ],
    companions: [{ source: "library.json", destination: join(stubHostDirectory, "library.json") }],
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
      `siblings/${sibling} is missing. CI checks it out from repo.json; locally, link or clone ` +
        `the ${sibling} checkout there at the commit repo.json pins.`,
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
  const libraryBuildDirectory = join(buildDirectory, library.buildName);
  const sourceDirectory = requireSibling(library.sibling);
  runCmake([
    "-S",
    sourceDirectory,
    "-B",
    libraryBuildDirectory,
    "-DCMAKE_BUILD_TYPE=Release",
    ...library.configureDefinitions,
  ]);
  const targetNames = library.targets.map((built) => built.target);
  runCmake(["--build", libraryBuildDirectory, "--config", "Release", "--target", ...targetNames, "--parallel"]);
  for (const built of library.targets) {
    copyFileSync(findBuiltLibrary(libraryBuildDirectory, built.fileName), join(built.destination, built.fileName));
  }
  for (const companion of library.companions) {
    copyFileSync(join(sourceDirectory, companion.source), companion.destination);
  }
}

mkdirSync(stubHostDirectory, { recursive: true });
for (const library of nativeLibraries) {
  buildNativeLibrary(library);
}
