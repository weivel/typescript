import { existsSync } from "node:fs";
import koffi from "koffi";
import { optionalTextForC, textForC } from "../core/text.js";
import { FunctionKind } from "../standard/constants.js";
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
  /** Whether a bytes function may still be called: false from the unload on, though the binary may stay open. */
  openToCalls: boolean;
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
    if (!state.openToCalls) {
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

/**
 * A definition service's object: the struct its symbol answered, at the library's own address, never a copy of it.
 * Its layout and operations are the library's, published in its own header; the host reads nothing of it but `size`.
 */
export interface LibraryDefinition {
  /** The import name of the library it came from. */
  readonly library: string;
  /** The struct's address, as koffi carries a pointer. */
  readonly pointer: object;
}

/** The smallest struct a definition answers: its `uint32_t size` and one pointer, under the platform's alignment. */
export const definitionSizeFloor = 2 * koffi.sizeof("void *");

type DefinitionSymbol = () => object | null;

/** A declared definition's symbol, resolved and not yet called. */
interface ResolvedDefinition {
  readonly symbol: string;
  readonly call: DefinitionSymbol;
}

function definitionSymbolOf(functions: readonly DeclaredFunction[]): string | undefined {
  return functions.find((declared) => declared.kind === FunctionKind.Definition)?.symbol;
}

/** @throws Error when the library does not export a definition's symbol. */
function resolveDefinitions(library: koffi.IKoffiLib, declaration: LibraryDeclaration): Map<string, ResolvedDefinition> {
  const resolved = new Map<string, ResolvedDefinition>();
  for (const service of declaration.services) {
    const symbol = definitionSymbolOf(service.functions);
    if (symbol !== undefined) {
      resolved.set(service.id, { symbol, call: library.func(symbol, "void *", []) as DefinitionSymbol });
    }
  }
  return resolved;
}

/** @throws Error, the caller's mistake, for a definition that answers NULL or a struct smaller than the floor. */
function readDefinition(importName: string, definition: ResolvedDefinition): LibraryDefinition {
  const answered = definition.call();
  if (answered === null) {
    throw new Error(`${importName}'s definition ${definition.symbol} answered NULL.`);
  }
  const size = koffi.decode(answered, "uint32_t") as number;
  if (size < definitionSizeFloor) {
    throw new Error(`${importName}'s definition ${definition.symbol} answered a struct of size ${size}, below ${definitionSizeFloor}.`);
  }
  return Object.freeze({ library: importName, pointer: answered });
}

function readDefinitions(importName: string, resolved: ReadonlyMap<string, ResolvedDefinition>): Map<string, LibraryDefinition> {
  return new Map([...resolved].map(([id, definition]) => [id, readDefinition(importName, definition)] as const));
}

/** @throws Error when the library does not export its release or a symbol a bytes function names, or names no release for one. */
function bindBytesServices(library: koffi.IKoffiLib, declaration: LibraryDeclaration, state: LoadState): Map<string, LibraryService> {
  const release = declaration.release === null ? undefined : (library.func(declaration.release, "void", ["void *"]) as NativeFunction);
  const bytesServices = declaration.services.filter((service) => definitionSymbolOf(service.functions) === undefined);
  return new Map(
    bytesServices.map((service) => {
      if (service.functions.length > 0 && release === undefined) {
        throw new Error(`${declaration.importName} declares bytes functions and no release.`);
      }
      return [service.id, bindService(library, service.functions, release!, state)] as const;
    }),
  );
}

export interface BoundLibrary {
  readonly services: ReadonlyMap<string, LibraryService>;
  readonly definitions: ReadonlyMap<string, LibraryDefinition>;
  /** Counts a definition service as registered, so the binary stays open until `released` is called for it. */
  awaitRelease(id: string): void;
  /** Says every holding of a definition service has ended since it was unregistered, or that it never was registered. */
  released(id: string): void;
  /** Refuses every later bytes call, and closes the binary once no definition service awaits its release. */
  unload(): void;
  /** Closes the binary now, whatever still awaits its release; a later call does nothing. */
  close(): void;
}

/**
 * Closes a library's binary once it is unloaded and every definition service it registered has had every holding
 * released, whichever ends last.
 *
 * @implNote A bytes answer is copied into JavaScript memory and released before its call answers, so no bytes the
 * library answered outlive a call, and calls are synchronous, so none is running when this decides.
 */
class BinaryClosing {
  readonly #awaiting = new Set<string>();
  #unloaded = false;
  #closed = false;

  constructor(
    readonly library: koffi.IKoffiLib,
    readonly state: LoadState,
    readonly onClosed: () => void,
  ) {}

  awaitRelease(id: string): void {
    this.#awaiting.add(id);
  }

  released(id: string): void {
    this.#awaiting.delete(id);
    this.#closeIfFree();
  }

  unload(): void {
    this.state.openToCalls = false;
    this.#unloaded = true;
    this.#closeIfFree();
  }

  close(): void {
    this.state.openToCalls = false;
    if (!this.#closed) {
      this.#closed = true;
      this.library.unload();
      this.onClosed();
    }
  }

  #closeIfFree(): void {
    if (this.#unloaded && this.#awaiting.size === 0) {
      this.close();
    }
  }
}

/** @throws EmbeddedNulError for a path or symbol the C loader would read cut short. */
function refuseTextsCutShort(path: string, declaration: LibraryDeclaration): void {
  textForC(path);
  optionalTextForC(declaration.release);
  declaration.services.forEach((service) => service.functions.forEach((declared) => textForC(declared.symbol)));
}

/**
 * Binds every bytes function of a declaration the layer accepted, and calls each definition's symbol once.
 *
 * @param onClosed called once the binary is closed.
 * @throws Error when the file is missing, does not export a symbol the declaration names, or a definition answers
 * NULL or a struct smaller than `2 * sizeof(void *)`; the binary is closed again before it throws.
 */
export function bindLibrary(path: string, declaration: LibraryDeclaration, onClosed: () => void = () => {}): BoundLibrary {
  refuseTextsCutShort(path, declaration);
  if (!existsSync(path)) {
    throw new Error(`The C library ${declaration.importName} is not at ${path}.`);
  }
  const library = koffi.load(path);
  const state: LoadState = { openToCalls: true };
  let services: Map<string, LibraryService>;
  let definitions: Map<string, LibraryDefinition>;
  try {
    let resolved: Map<string, ResolvedDefinition>;
    try {
      services = bindBytesServices(library, declaration, state);
      resolved = resolveDefinitions(library, declaration);
    } catch (error) {
      throw new Error(`The C library at ${path} does not export every symbol ${declaration.importName} declares.`, { cause: error });
    }
    definitions = readDefinitions(declaration.importName, resolved);
  } catch (error) {
    library.unload();
    throw error;
  }
  const closing = new BinaryClosing(library, state, onClosed);
  return {
    services,
    definitions,
    awaitRelease: (id) => closing.awaitRelease(id),
    released: (id) => closing.released(id),
    unload: () => closing.unload(),
    close: () => closing.close(),
  };
}
