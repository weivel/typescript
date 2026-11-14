import { existsSync } from "node:fs";
import koffi from "koffi";
import type { LibraryDeclaration, LibraryFunction as DeclaredFunction } from "../standard/index.js";
import type { LibraryFunction, LibraryService } from "./model.js";

type NativeFunction = (...parameters: unknown[]) => unknown;

const bytesParameters = ["const void *", "size_t", "_Out_ void **", "_Out_ size_t *"];
const statusOk = 0;

/** A bytes function's answer other than 0: its status, its body as bytes, and the body's text where it is UTF-8. */
export class LibraryCallError extends Error {
  readonly status: number;
  readonly symbol: string;
  readonly body: Uint8Array;
  /** The body read as UTF-8, or undefined when it is not UTF-8. */
  readonly text: string | undefined;

  constructor(symbol: string, status: number, body: Uint8Array) {
    const text = utf8TextOf(body);
    super(`${symbol} answered status ${status}: ${describeBody(body, text)}`);
    this.name = "LibraryCallError";
    this.status = status;
    this.symbol = symbol;
    this.body = body;
    this.text = text;
  }
}

/** A call to a function of a library that has been unloaded, refused before it reaches unmapped code. */
export class LibraryUnloadedError extends Error {
  readonly symbol: string;

  constructor(symbol: string) {
    super(`${symbol} belongs to a C library that has been unloaded.`);
    this.name = "LibraryUnloadedError";
    this.symbol = symbol;
  }
}

interface LoadState {
  loaded: boolean;
}

function utf8TextOf(body: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return undefined;
  }
}

function describeBody(body: Uint8Array, text: string | undefined): string {
  if (body.length === 0) {
    return "and no text saying why";
  }
  return text ?? `and ${body.length} bytes that are not UTF-8`;
}

function copyBody(pointer: object | null, length: number): Uint8Array {
  if (pointer === null || length === 0) {
    return new Uint8Array(0);
  }
  return new Uint8Array(koffi.view(pointer, length)).slice();
}

/** Binds `symbol` through koffi as the bytes ABI of weivel_standard_function_kind, with nothing of the layer around it. */
export function bindBareBytesFunction(library: koffi.IKoffiLib, symbol: string): NativeFunction {
  return library.func(symbol, "int32_t", bytesParameters) as NativeFunction;
}

function bindFunction(library: koffi.IKoffiLib, symbol: string, release: NativeFunction, state: LoadState): LibraryFunction {
  const native = bindBareBytesFunction(library, symbol);
  return (input) => {
    if (!state.loaded) {
      throw new LibraryUnloadedError(symbol);
    }
    const output: (object | null)[] = [null];
    const outputLength: number[] = [0];
    const status = native(input, input.length, output, outputLength) as number;
    let body: Uint8Array;
    try {
      body = copyBody(output[0] ?? null, Number(outputLength[0]));
    } finally {
      if (output[0] !== null) {
        release(output[0]);
      }
    }
    if (status !== statusOk) {
      throw new LibraryCallError(symbol, status, body);
    }
    return body;
  };
}

function bindService(
  library: koffi.IKoffiLib,
  functions: readonly DeclaredFunction[],
  release: NativeFunction,
  state: LoadState,
): LibraryService {
  return Object.fromEntries(
    functions.map((declared) => [declared.name, bindFunction(library, declared.symbol, release, state)]),
  );
}

function unloadOnce(library: koffi.IKoffiLib, state: LoadState): void {
  if (state.loaded) {
    state.loaded = false;
    library.unload();
  }
}

export interface BoundLibrary {
  readonly services: ReadonlyMap<string, LibraryService>;
  /** Unloads the library once; a later call does nothing, and a bound function then throws LibraryUnloadedError. */
  unload(): void;
}

/**
 * Binds every function of a declaration the layer accepted, each as the bytes ABI of weivel_standard_function_kind.
 *
 * @throws Error when the file is missing or does not export a symbol the declaration names.
 */
export function bindLibrary(path: string, declaration: LibraryDeclaration): BoundLibrary {
  if (!existsSync(path)) {
    throw new Error(`The C library ${declaration.importName} is not at ${path}.`);
  }
  const library = koffi.load(path);
  const state: LoadState = { loaded: true };
  try {
    const release = library.func(declaration.release, "void", ["void *"]) as NativeFunction;
    const services = new Map(
      declaration.services.map((service) => [service.id, bindService(library, service.functions, release, state)] as const),
    );
    return { services, unload: () => unloadOnce(library, state) };
  } catch (error) {
    library.unload();
    throw new Error(`The C library at ${path} does not export every symbol ${declaration.importName} declares.`, {
      cause: error,
    });
  }
}
