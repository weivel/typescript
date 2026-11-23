import { build } from "esbuild";
import { basename, extname, join } from "node:path";

/** The core's and the standard's shared libraries a bundled program loads, each by an absolute path. */
export interface NativeLibraryPaths {
  readonly coreLibraryPath: string;
  readonly standardLibraryPath: string;
}

export interface BundleProgramOptions {
  /**
   * Where the bundled program finds the core's and the standard's shared libraries: `"beside-the-bundle"`, the
   * default, resolves them when it runs in the bundle's own directory under the file names CMake gives them on the
   * platform it runs on (`weivel_core.dll` and `weivel_standard.dll` on Windows, `libweivel_core.dylib` and
   * `libweivel_standard.dylib` on macOS, `libweivel_core.so` and `libweivel_standard.so` elsewhere); explicit paths
   * are written into the bundle as they are.
   */
  readonly nativeLibraries?: "beside-the-bundle" | NativeLibraryPaths;
}

/** The two files `bundleProgram` writes: the command line, and the module exporting `startHost`. */
export interface BundledProgram {
  readonly commandLine: string;
  readonly inProcess: string;
}

const nodeTarget = "node22";
const programDirectory = join(import.meta.dirname, "..", "program");
const commandLineFileName = "weivel-host.mjs";
const inProcessFileName = "weivel-host-in-process.mjs";

const besideTheBundleSource = [
  `import { fileURLToPath } from "node:url";`,
  `import { sharedLibraryFileName } from "../core/library-file.js";`,
  `const besideTheBundle = (name) => fileURLToPath(new URL("./" + sharedLibraryFileName(name), import.meta.url));`,
  `const nativeLibraries = { coreLibraryPath: besideTheBundle("weivel_core"), standardLibraryPath: besideTheBundle("weivel_standard") };`,
];

/** The statements that declare `nativeLibraries`, the core's and the standard's shared libraries a bundle loads. */
function nativeLibrariesSource(nativeLibraries: BundleProgramOptions["nativeLibraries"]): readonly string[] {
  return nativeLibraries === undefined || nativeLibraries === "beside-the-bundle"
    ? besideTheBundleSource
    : [`const nativeLibraries = ${JSON.stringify({ coreLibraryPath: nativeLibraries.coreLibraryPath, standardLibraryPath: nativeLibraries.standardLibraryPath })};`];
}

/** The command line's entry, handed the native libraries it loads. */
function commandLineEntrySource(nativeLibraries: BundleProgramOptions["nativeLibraries"]): string {
  return [`import { main } from "./main.js";`, ...nativeLibrariesSource(nativeLibraries), `process.exitCode = await main(process.argv.slice(2), nativeLibraries);`].join("\n");
}

/** The in-process entry: `startHost`, each native library the caller leaves out the bundle's own, and nothing run. */
function inProcessEntrySource(nativeLibraries: BundleProgramOptions["nativeLibraries"]): string {
  return [
    `import { startHost as startHostWith } from "./run.js";`,
    ...nativeLibrariesSource(nativeLibraries),
    `export function startHost(options) {`,
    `  return startHostWith({ ...options, coreLibraryPath: options.coreLibraryPath ?? nativeLibraries.coreLibraryPath, standardLibraryPath: options.standardLibraryPath ?? nativeLibraries.standardLibraryPath });`,
    `}`,
  ].join("\n");
}

/** Bundles the program's entry `source` into `outputFile`, koffi left a bare import. */
async function bundleProgramEntry(source: string, sourceFile: string, outputFile: string): Promise<void> {
  await build({
    stdin: { contents: source, resolveDir: programDirectory, sourcefile: sourceFile, loader: "ts" },
    outfile: outputFile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: nodeTarget,
    external: ["koffi"],
    logLevel: "silent",
  });
}

/**
 * Bundles the plugin entry module `entry` and every module it imports into one ES module file in `outputDirectory`,
 * named as `entry` with the extension `.mjs`, and answers that file's path. Node's own modules stay imports.
 *
 * @implNote `.mjs` makes the file an ES module wherever it is written, whatever `package.json` sits above it.
 * @throws Error when esbuild cannot resolve or compile what the entry imports.
 */
export async function bundlePlugin(entry: string, outputDirectory: string): Promise<string> {
  const outputFile = join(outputDirectory, `${basename(entry, extname(entry))}.mjs`);
  await build({ entryPoints: [entry], outfile: outputFile, bundle: true, format: "esm", platform: "node", target: nodeTarget, logLevel: "silent" });
  return outputFile;
}

/**
 * Bundles the host program into two ES module files in `outputDirectory` and answers their paths: the command line,
 * `weivel-host.mjs`, run as `node weivel-host.mjs <host library> <arguments...>` as the package's `weivel-host` is, and
 * `weivel-host-in-process.mjs`, which exports `startHost` alone and runs nothing on import, for a process that hosts
 * the program itself.
 *
 * Everything but koffi is inside each file. koffi, a native addon that cannot be bundled, stays the bare import
 * `koffi`, which Node resolves from a `node_modules/koffi` in the bundle's directory or one above it. The core's and
 * the standard's shared libraries are found as `options.nativeLibraries` says, beside the bundle by default, unless a
 * caller of `startHost` names its own. So a bundle beside those two libraries, under a `node_modules` holding koffi,
 * runs wherever that directory is moved.
 *
 * @throws Error when esbuild cannot bundle the program.
 */
export async function bundleProgram(outputDirectory: string, options: BundleProgramOptions = {}): Promise<BundledProgram> {
  const commandLine = join(outputDirectory, commandLineFileName);
  const inProcess = join(outputDirectory, inProcessFileName);
  await bundleProgramEntry(commandLineEntrySource(options.nativeLibraries), "weivel-host.ts", commandLine);
  await bundleProgramEntry(inProcessEntrySource(options.nativeLibraries), "weivel-host-in-process.ts", inProcess);
  return { commandLine, inProcess };
}
