import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isHostDestroyed, type Host, type LoadedLibrary } from "../host/index.js";
import { messageOf } from "../host/activation-failure.js";
import type { Standard } from "../standard/index.js";

/** The name of the declaration a host program reads beside the host library it was started with. */
export const declarationFileName = "library.json";

/**
 * Loads a C library from its binary and the declaration the standard reads, as host services, withholding
 * `weivel.host` and `weivel.scope` from every plugin: the program binds them for itself, and a scope is made for one
 * plugin and handed to no other.
 *
 * @throws Error when the declaration cannot be read or the standard refuses it, or for every reason
 * `Host.loadLibrary` throws.
 */
export function loadDeclaredLibrary(host: Host, standard: Standard, binary: string, declarationPath: string): LoadedLibrary {
  let json: string;
  try {
    json = readFileSync(declarationPath, "utf8");
  } catch (error) {
    throw new Error(`The declaration ${declarationPath} could not be read: ${messageOf(error)}`, { cause: error });
  }
  const declaration = standard.readLibrary(json);
  if (declaration.value === undefined) {
    throw new Error(`The standard refused the declaration ${declarationPath}: ${declaration.refusal?.detail ?? `status ${declaration.status}`}.`);
  }
  const ids = standard.serviceIds;
  const loaded = host.loadLibrary(declaration.value, binary, { withheld: [ids.host, ids.scope] });
  if (isHostDestroyed(loaded)) {
    throw new Error(`The host was destroyed before ${binary} was loaded.`);
  }
  return loaded;
}

/** Loads the library a host program was started with, its declaration the `library.json` beside its binary. */
export function loadHostLibrary(host: Host, standard: Standard, binary: string): LoadedLibrary {
  return loadDeclaredLibrary(host, standard, binary, join(dirname(binary), declarationFileName));
}
