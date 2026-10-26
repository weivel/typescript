import type { LoadedLibrary } from "./bridge.js";
import type { LibraryDeclaration } from "./declaration.js";

/** A service a library offers, in the shape the host registers it. */
export interface LibraryServiceImplementation {
  id: string;
  implementation: Record<string, (argument: unknown) => unknown>;
}

/**
 * Assembles each declared service by walking the declaration, one method per function.
 *
 * @remarks
 * No per-function code exists: every `json` function shares one call path, so a method is only the
 * symbol it forwards to.
 */
export function servicesOf(library: LoadedLibrary, declaration: LibraryDeclaration): LibraryServiceImplementation[] {
  return declaration.services.map((service) => ({
    id: service.id,
    implementation: Object.fromEntries(
      service.functions.map((fn) => [fn.name, (argument: unknown) => library.call(fn.symbol, argument)]),
    ),
  }));
}
