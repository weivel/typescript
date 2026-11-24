import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const LIBRARY_DECLARATION = "library.json";

export type ScratchFile =
  | { readonly path: string; readonly content: unknown }
  | { readonly path: string; readonly copyFrom: string };

export interface PlacedLibrary {
  readonly directory: string;
  readonly binary: string;
}

export interface ScratchLayout {
  /** Starts the name of the temporary folder. */
  readonly prefix: string;
  /** Library name to the source directory holding its one binary and its `library.json`. */
  readonly libraries: Readonly<Record<string, string>>;
  /** The variables to set while the home lives, given the home's base. */
  environment(base: string): Readonly<Record<string, string>>;
  /** The files to write, given the home's base and where each library was placed. A string `content` is written as is, anything else as JSON. */
  files(base: string, libraries: Readonly<Record<string, PlacedLibrary>>): readonly ScratchFile[];
}

export interface ScratchHome {
  readonly base: string;
  readonly libraries: Readonly<Record<string, PlacedLibrary>>;
  /** Puts every variable the layout set back as it was, deleting one that was unset, and deletes the home. */
  remove(): void;
}

function ensuredDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
}

function placeFile(file: ScratchFile): void {
  ensuredDirectory(dirname(file.path));
  if ("copyFrom" in file) {
    copyFileSync(file.copyFrom, file.path);
    return;
  }
  writeFileSync(file.path, typeof file.content === "string" ? file.content : JSON.stringify(file.content));
}

function placeLibrary(base: string, name: string, source: string): PlacedLibrary {
  const names = readdirSync(source);
  const binaryName = names.find((fileName) => fileName !== LIBRARY_DECLARATION);
  if (binaryName === undefined) throw new Error(`${source} holds no binary beside ${LIBRARY_DECLARATION}`);
  const directory = join(base, "libraries", name);
  ensuredDirectory(directory);
  for (const fileName of names) copyFileSync(join(source, fileName), join(directory, fileName));
  return { directory, binary: join(directory, binaryName) };
}

function placeLibraries(base: string, sources: Readonly<Record<string, string>>): Record<string, PlacedLibrary> {
  return Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, placeLibrary(base, name, source)]));
}

/**
 * Sets every variable and answers the function that puts them back.
 * @implNote A variable that was unset is deleted on restore: assigning `undefined` to `process.env` stores the text "undefined".
 */
function setEnvironment(variables: Readonly<Record<string, string>>): () => void {
  const saved = Object.keys(variables).map((name) => [name, process.env[name]] as const);
  Object.assign(process.env, variables);
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

/**
 * A fresh folder under the temporary directory, named by its real path.
 * @implNote macOS's temporary directory sits under `/var`, a link to `/private/var`, and what a process resolves there
 * is the real path, so a path a test builds is compared only once it is real too.
 */
function realTemporaryFolder(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/**
 * Lays out a fresh home as `layout` describes it: the libraries copied to `<base>/libraries/<name>`, the files written,
 * and the environment pointing into it until `remove`. A layout that throws partway puts the environment back and
 * deletes the home before the error is rethrown.
 */
export function scratchHome(layout: ScratchLayout): ScratchHome {
  const base = realTemporaryFolder(layout.prefix);
  let restoreEnvironment = (): void => {};
  const remove = (): void => {
    restoreEnvironment();
    rmSync(base, { recursive: true, force: true });
  };
  try {
    restoreEnvironment = setEnvironment(layout.environment(base));
    const libraries = placeLibraries(base, layout.libraries);
    layout.files(base, libraries).forEach(placeFile);
    return { base, libraries, remove };
  } catch (error) {
    remove();
    throw error;
  }
}
