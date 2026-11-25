import { bundlePlugin, bundleProgram, type NativeLibraryPaths } from "./bundle.js";

const usage = ["usage: weivel-bundle program <output directory> [--core <path> --standard <path>]", "       weivel-bundle plugin <entry> <output directory>"].join("\n");

const misuseExit = 2;
const failureExit = 1;

type Parsed = { readonly ok: true; readonly run: () => Promise<readonly string[]> } | { readonly ok: false };

const refused: Parsed = { ok: false };

/** The value of each `--core` and `--standard` in `flags`, or undefined when a flag is unknown, repeated or lacks its value. */
function nativeLibraryFlags(flags: readonly string[]): { core?: string; standard?: string } | undefined {
  const values: { core?: string; standard?: string } = {};
  for (let index = 0; index < flags.length; index += 2) {
    const name = flags[index];
    const value = flags[index + 1];
    if ((name !== "--core" && name !== "--standard") || value === undefined || values[name.slice(2) as "core" | "standard"] !== undefined) {
      return undefined;
    }
    values[name.slice(2) as "core" | "standard"] = value;
  }
  return values;
}

/** The two paths when both flags are given, `"beside-the-bundle"` when neither is, undefined when only one is. */
function nativeLibrariesOf(flags: readonly string[]): NativeLibraryPaths | "beside-the-bundle" | undefined {
  const values = nativeLibraryFlags(flags);
  if (values === undefined || (values.core === undefined) !== (values.standard === undefined)) {
    return undefined;
  }
  return values.core === undefined || values.standard === undefined ? "beside-the-bundle" : { coreLibraryPath: values.core, standardLibraryPath: values.standard };
}

function parseProgram(rest: readonly string[]): Parsed {
  const [outputDirectory, ...flags] = rest;
  const nativeLibraries = nativeLibrariesOf(flags);
  if (outputDirectory === undefined || outputDirectory.startsWith("--") || nativeLibraries === undefined) {
    return refused;
  }
  return {
    ok: true,
    run: async () => {
      const program = await bundleProgram(outputDirectory, { nativeLibraries });
      return [program.commandLine, program.inProcess];
    },
  };
}

function parsePlugin(rest: readonly string[]): Parsed {
  const [entry, outputDirectory, ...surplus] = rest;
  if (entry === undefined || outputDirectory === undefined || surplus.length > 0) {
    return refused;
  }
  return { ok: true, run: async () => [await bundlePlugin(entry, outputDirectory)] };
}

function parse(argv: readonly string[]): Parsed {
  const [word, ...rest] = argv;
  if (word === "program") {
    return parseProgram(rest);
  }
  return word === "plugin" ? parsePlugin(rest) : refused;
}

/**
 * The bundler's command line: `program <output directory> [--core <path> --standard <path>]` writes the host program's
 * two files and `plugin <entry> <output directory>` writes the plugin's one, each path printed on a line of its own.
 * Answers the code to exit with: 0 on success, 2 with the usage on a misuse, 1 with the error when bundling fails.
 */
export async function bundleCommandLine(argv: readonly string[]): Promise<number> {
  const parsed = parse(argv);
  if (!parsed.ok) {
    console.error(usage);
    return misuseExit;
  }
  try {
    (await parsed.run()).forEach((path) => console.log(path));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return failureExit;
  }
}
