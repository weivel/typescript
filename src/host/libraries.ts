import { existsSync } from "node:fs";
import koffi from "koffi";
import type { LibraryDeclaration, LibraryFunction as DeclaredFunction } from "../standard/index.js";
import type { LibraryFunction, LibraryService } from "./model.js";

type NativeFunction = (...parameters: unknown[]) => unknown;

const bytesParameters = ["const void *", "size_t", "_Out_ void **", "_Out_ size_t *"];
const statusOk = 0;

/** A bytes function's answer other than 0: its status, and the text its body carried. */
export class LibraryCallError extends Error {
  readonly status: number;
  readonly symbol: string;

  constructor(symbol: string, status: number, body: Uint8Array) {
    super(`${symbol} answered status ${status}: ${textOf(body)}`);
    this.name = "LibraryCallError";
    this.status = status;
    this.symbol = symbol;
  }
}

function textOf(body: Uint8Array): string {
  if (body.length === 0) {
    return "and no text saying why";
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return `and ${body.length} bytes that are not UTF-8`;
  }
}

function copyBody(pointer: object | null, length: number): Uint8Array {
  if (pointer === null || length === 0) {
    return new Uint8Array(0);
  }
  return new Uint8Array(koffi.view(pointer, length)).slice();
}

function bindFunction(library: koffi.IKoffiLib, symbol: string, release: NativeFunction): LibraryFunction {
  const native = library.func(symbol, "int32_t", bytesParameters) as NativeFunction;
  return (input) => {
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

function bindService(library: koffi.IKoffiLib, functions: readonly DeclaredFunction[], release: NativeFunction): LibraryService {
  return Object.fromEntries(functions.map((declared) => [declared.name, bindFunction(library, declared.symbol, release)]));
}

export interface BoundLibrary {
  readonly services: ReadonlyMap<string, LibraryService>;
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
  try {
    const release = library.func(declaration.release, "void", ["void *"]) as NativeFunction;
    const services = new Map(
      declaration.services.map((service) => [service.id, bindService(library, service.functions, release)] as const),
    );
    return { services, unload: () => library.unload() };
  } catch (error) {
    library.unload();
    throw new Error(`The C library at ${path} does not export every symbol ${declaration.importName} declares.`, {
      cause: error,
    });
  }
}
