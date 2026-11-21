import { build, type Plugin as EsbuildPlugin } from "esbuild";
import { createRequire } from "node:module";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultCoreLibraryPath } from "../core/index.js";
import { defaultStandardLibraryPath } from "../standard/index.js";

export interface BundleProgramOptions {
  /** The core's shared library the bundled program loads; this package's `native/` one by default. */
  readonly coreLibraryPath?: string;
  /** The standard's shared library the bundled program loads; this package's `native/` one by default. */
  readonly standardLibraryPath?: string;
}

const nodeTarget = "node22";
const programDirectory = join(import.meta.dirname, "..", "program");
const programFileName = "weivel-host.mjs";

/**
 * Keeps `koffi` out of the bundle, importing it from this package's own install by its file URL.
 *
 * @implNote A native addon cannot be bundled, and a bare `koffi` would resolve from wherever the bundle is written,
 * which need not sit under any `node_modules` that holds it.
 */
const koffiFromThisPackage: EsbuildPlugin = {
  name: "koffi-from-this-package",
  setup(builder) {
    const koffiUrl = pathToFileURL(createRequire(import.meta.url).resolve("koffi")).href;
    builder.onResolve({ filter: /^koffi$/ }, () => ({ path: koffiUrl, external: true }));
  },
};

/** The bundled program's entry: the command line, handed the native libraries it loads. */
function programEntrySource(options: BundleProgramOptions): string {
  const libraries = {
    coreLibraryPath: options.coreLibraryPath ?? defaultCoreLibraryPath(),
    standardLibraryPath: options.standardLibraryPath ?? defaultStandardLibraryPath(),
  };
  return [`import { main } from "./main.js";`, `process.exitCode = await main(process.argv.slice(2), ${JSON.stringify(libraries)});`].join("\n");
}

/**
 * Bundles the plugin entry module `entry` and every module it imports into one ES module file in `outputDirectory`,
 * named as `entry` with the extension `.mjs`, and answers that file's path. Node's own modules stay imports.
 *
 * @implNote `.mjs` makes the file an ES module wherever it is written, whatever `package.json` sits above it.
 *
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
 * Everything but koffi is inside the file. koffi is imported from this package's install by its absolute file URL,
 * and the core's and the standard's shared libraries are loaded from the absolute paths `options` gives, by default
 * the ones in this package's `native/`, the same files the unbundled program loads. So the bundle runs wherever it
 * is written, on the machine whose install it was made from.
 *
 * @throws Error when esbuild cannot bundle the program.
 */
export async function bundleProgram(outputDirectory: string, options: BundleProgramOptions = {}): Promise<string> {
  const outputFile = join(outputDirectory, programFileName);
  await build({
    stdin: { contents: programEntrySource(options), resolveDir: programDirectory, sourcefile: "weivel-host.ts", loader: "ts" },
    outfile: outputFile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: nodeTarget,
    plugins: [koffiFromThisPackage],
    logLevel: "silent",
  });
  return outputFile;
}
