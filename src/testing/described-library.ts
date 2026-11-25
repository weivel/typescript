import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EdgeSource } from "../core/index.js";
import { Host, isHostDestroyed, type BoundDefinition } from "../host/index.js";
import type { LibraryDeclaration } from "../standard/answers.js";
import { loadStandard, type Standard } from "../standard/index.js";
import { LIBRARY_DECLARATION, libraryBinaryName } from "./scratch-home.js";

export interface DescribedLibraryOptions {
  /** The core's shared library; the host's default when absent. */
  readonly coreLibraryPath?: string;
  /** The standard's shared library, which reads the declaration and checks each description; its default when absent. */
  readonly standardLibraryPath?: string;
}

export interface DescribedLibrary {
  /** Each service the library declares with a description, bound as a plugin would get it, by id. */
  readonly described: ReadonlyMap<string, BoundDefinition>;
  /** Unloads the library and destroys the host that loaded it. */
  close(): Promise<void>;
}

function declarationIn(directory: string, standardLibraryPath: string | undefined): { standard: Standard; declaration: LibraryDeclaration } {
  const standard = loadStandard(standardLibraryPath);
  const read = standard.readLibrary(readFileSync(join(directory, LIBRARY_DECLARATION), "utf8"));
  if (read.value === undefined) {
    throw new Error(`The standard refused ${join(directory, LIBRARY_DECLARATION)}: ${read.refusal?.detail ?? `status ${read.status}`}.`);
  }
  return { standard, declaration: read.value };
}

/**
 * Loads the C library in `directory`, its one binary beside its `library.json`, on a host of its own given the
 * standard's description check, so a test calls any described library's operations with no binding written by hand.
 *
 * @throws Error when the declaration cannot be read or is refused, and for every reason `Host.loadLibrary` throws, the
 * host destroyed again.
 */
export function describedLibrary(directory: string, options: DescribedLibraryOptions = {}): DescribedLibrary {
  const { standard, declaration } = declarationIn(directory, options.standardLibraryPath);
  const host = Host.create({
    edgeSource: EdgeSource.Capabilities,
    coreLibraryPath: options.coreLibraryPath,
    descriptionCheck: (description, definition) => standard.checkDescription(description, definition),
  });
  try {
    const loaded = host.loadLibrary(declaration, join(directory, libraryBinaryName(directory)));
    if (isHostDestroyed(loaded)) throw new Error(`The host was destroyed before ${directory} was loaded.`);
    return { described: loaded.described, close: () => host.destroy() };
  } catch (error) {
    void host.destroy();
    throw error;
  }
}
