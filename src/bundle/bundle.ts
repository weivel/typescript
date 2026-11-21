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

const nodeTarget = "node22";
const programDirectory = join(import.meta.dirname, "..", "program");
const programFileName = "weivel-host.mjs";

const besideTheBundleSource = [
  `import { fileURLToPath } from "node:url";`,
  `import { sharedLibraryFileName } from "../core/library-file.js";`,
  `const besideTheBundle = (name) => fileURLToPath(new URL("./" + sharedLibraryFileName(name), import.meta.url));`,
  `const nativeLibraries = { coreLibraryPath: besideTheBundle("weivel_core"), standardLibraryPath: besideTheBundle("weivel_standard") };`,
];

/** The bundled program's entry: the command line, handed the native libraries it loads. */
function programEntrySource(nativeLibraries: BundleProgramOptions["nativeLibraries"]): string {
  const located =
    nativeLibraries === undefined || nativeLibraries === "beside-the-bundle"
      ? besideTheBundleSource
      : [`const nativeLibraries = ${JSON.stringify({ coreLibraryPath: nativeLibraries.coreLibraryPath, standardLibraryPath: nativeLibraries.standardLibraryPath })};`];
  return [`import { main } from "./main.js";`, ...located, `process.exitCode = await main(process.argv.slice(2), nativeLibraries);`].join("\n");
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
 * Bundles the host program's command line into one ES module file in `outputDirectory`, `weivel-host.mjs`, and answers
 * its path; it runs as `node weivel-host.mjs <host library> <arguments...>`, as the package's `weivel-host` does.
 *
 * Everything but koffi is inside the file. koffi, a native addon that cannot be bundled, stays the bare import
 * `koffi`, which Node resolves from a `node_modules/koffi` in the bundle's directory or one above it. The core's and
 * the standard's shared libraries are found as `options.nativeLibraries` says, beside the bundle by default. So a
 * bundle beside those two libraries, under a `node_modules` holding koffi, runs wherever that directory is moved.
 *
 * @throws Error when esbuild cannot bundle the program.
 */
export async function bundleProgram(outputDirectory: string, options: BundleProgramOptions = {}): Promise<string> {
  const outputFile = join(outputDirectory, programFileName);
  await build({
    stdin: { contents: programEntrySource(options.nativeLibraries), resolveDir: programDirectory, sourcefile: "weivel-host.ts", loader: "ts" },
    outfile: outputFile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: nodeTarget,
    external: ["koffi"],
    logLevel: "silent",
  });
  return outputFile;
}
