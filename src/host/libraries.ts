import { existsSync } from "node:fs";
import koffi from "koffi";
import { Status } from "../core/constants.js";
import { optionalTextForC, textForC } from "../core/text.js";
import { FunctionKind } from "../standard/constants.js";
import type { LibraryDeclaration, LibraryFunction as DeclaredFunction } from "../standard/index.js";
import { bindDescribed, type BoundDefinition } from "./description/definition.js";
import { HandleHoldings } from "./description/handles.js";
import { DescribedReturn } from "./description/layout.js";
import type { CallTracking } from "./description/operations.js";
import { readDescription, type Description } from "./description/reader.js";
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

/** A load that ran out of memory where the platform could not go on, as a description check answering OUT_OF_MEMORY: never the caller's mistake. */
export class OutOfMemoryError extends Error {
  constructor(what: string) {
    super(`${what} ran out of memory.`);
    this.name = "OutOfMemoryError";
  }
}

interface LoadState {
  /** Whether a bytes function may still be called: false from the unload on, though the binary may stay open. */
  openToCalls: boolean;
  /** Whether the binary is still open, so a described definition, which its holders keep past the unload, may be called. */
  binaryOpen: boolean;
  /** Whether the binary is still mapped, so a provider's release may still run after the binary closed to calls. */
  mapped: boolean;
  /** How many blocking calls are running on koffi's worker thread, inside the binary. */
  running: number;
  /** Called once `running` falls to 0, while the binary waits to be closed under the calls still running. */
  whenIdle: (() => void) | undefined;
}

/** Counts a load's worker calls, calling its `whenIdle` once the last of them has returned. */
function callTrackingOf(state: LoadState): CallTracking {
  return {
    begin: () => {
      state.running += 1;
    },
    end: () => {
      state.running -= 1;
      if (state.running === 0) {
        state.whenIdle?.();
      }
    },
  };
}

/** What a description check answered: OK, or another status with the refusal saying why. */
export interface DescriptionCheckAnswer {
  readonly status: number;
  readonly refusal: { readonly detail: string | null; readonly path: string } | undefined;
}

/**
 * Checks a description before the host reads anything of it, as weivel_standard_description_check does, and, given
 * the definition a service's symbol answered, that the description answers that definition, as
 * weivel_standard_description_answers does: the host never loads the standard itself, so its caller hands it the
 * standard's check. `definition` is null for a contract's description, which answers no definition.
 */
export type DescriptionCheck = (description: object, definition: object | null) => DescriptionCheckAnswer;

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

type DescriptionSymbol = () => object | null;

/** The definition a service's description must answer: what its symbol answered, and the symbol, as an error names it. */
interface AnsweredDefinition {
  readonly pointer: object;
  readonly symbol: string;
}

/**
 * The description `symbol` answers, once `check` has passed it and, for a service, found it answers `answered`.
 *
 * @param subject what declares the description, as an error names it.
 * @param answered the service's definition, or null for a contract's description.
 * @throws Error, the caller's mistake, for no `check`, or a description that answers NULL or the check refuses;
 * OutOfMemoryError for a check answering OUT_OF_MEMORY.
 */
function checkedDescription(
  library: koffi.IKoffiLib,
  importName: string,
  symbol: string,
  subject: string,
  check: DescriptionCheck | undefined,
  answered: AnsweredDefinition | null,
): object {
  if (check === undefined) {
    throw new Error(`${importName}'s ${subject} declares a description, and the host was given no descriptionCheck.`);
  }
  const description = (library.func(symbol, "void *", []) as DescriptionSymbol)();
  if (description === null) {
    throw new Error(`${importName}'s description ${symbol} answered NULL.`);
  }
  const checked = check(description, answered?.pointer ?? null);
  if (checked.status === Status.OutOfMemory) {
    throw new OutOfMemoryError(`The check of ${importName}'s description ${symbol}`);
  }
  if (checked.status !== statusOk) {
    const where = checked.refusal === undefined ? "" : ` at ${checked.refusal.path === "" ? "its root" : checked.refusal.path}: ${checked.refusal.detail}`;
    const describing = answered === null ? "" : ` for the definition ${answered.symbol}`;
    throw new Error(`${importName}'s description ${symbol}, which its ${subject} declares${describing}, was refused by the check, status ${checked.status}${where}.`);
  }
  return description;
}

/** The operations an implementation of a contract offers: every one answering a status, in the description's order, never a release. */
function contractOperations(description: Description): readonly string[] {
  return Object.freeze(description.operations.filter((operation) => operation.returns === DescribedReturn.Status).map((operation) => operation.name));
}

/**
 * Reads every contract a declaration publishes, by capability, as the operations an implementation of it offers.
 *
 * @throws Error, the caller's mistake, for a contract whose description is not exported, answers NULL or is refused
 * by the check, or declared to a host given no `check`; OutOfMemoryError for a check answering OUT_OF_MEMORY.
 */
function readContracts(library: koffi.IKoffiLib, declaration: LibraryDeclaration, check: DescriptionCheck | undefined): Map<string, readonly string[]> {
  const contracts = new Map<string, readonly string[]>();
  for (const contract of declaration.contracts ?? []) {
    const subject = `contract ${contract.capability}`;
    const description = checkedDescription(library, declaration.importName, contract.description, subject, check, null);
    contracts.set(contract.capability, contractOperations(readDescription(description)));
  }
  return contracts;
}

/**
 * Binds every described definition from its description, after the check has passed it.
 *
 * @throws Error, the caller's mistake, for a description symbol that is not exported or answers NULL, one the check
 * refuses, or one whose layout this platform disagrees with; OutOfMemoryError for a check answering OUT_OF_MEMORY.
 */
function bindDescribedDefinitions(
  library: koffi.IKoffiLib,
  declaration: LibraryDeclaration,
  definitions: ReadonlyMap<string, LibraryDefinition>,
  check: DescriptionCheck | undefined,
  binding: { holdings: HandleHoldings; state: LoadState },
): Map<string, BoundDefinition> {
  const bound = new Map<string, BoundDefinition>();
  for (const service of declaration.services) {
    if (service.description === undefined) {
      continue;
    }
    const definition = definitions.get(service.id)!;
    const answered = { pointer: definition.pointer, symbol: definitionSymbolOf(service.functions)! };
    const description = checkedDescription(library, declaration.importName, service.description, `service ${service.id}`, check, answered);
    bound.set(
      service.id,
      bindDescribed({
        definition,
        description: readDescription(description),
        holdings: binding.holdings,
        isOpen: () => binding.state.binaryOpen,
        canRelease: () => binding.state.mapped,
        calls: callTrackingOf(binding.state),
      }),
    );
  }
  return bound;
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
  /** Each definition service that declares a description, by id, as the object its description binds. */
  readonly described: ReadonlyMap<string, BoundDefinition>;
  /** Each contract the library publishes, by capability, as the operations an implementation of it offers. */
  readonly contracts: ReadonlyMap<string, readonly string[]>;
  /** Counts a definition service as registered, so the binary stays open until `released` is called for it. */
  awaitRelease(id: string): void;
  /** Says every holding of a definition service has ended since it was unregistered, or that it never was registered. */
  released(id: string): void;
  /**
   * Refuses every later bytes call, releases every handle a described definition answered and nobody released, and
   * closes the binary once no definition service awaits its release.
   */
  unload(): void;
  /** Closes the binary now, whatever still awaits its release; a later call does nothing. */
  close(): void;
}

/**
 * Closes a library's binary once it is unloaded and every definition service it registered has had every holding
 * released, whichever ends last.
 *
 * @implNote A bytes answer and a described answer are copied into JavaScript memory and released before their call
 * settles, so nothing the library answered outlives a call but a handle or an answer carrying a definition, which the
 * unload releases. A blocking call may still be running on koffi's worker thread when this decides, so the binary is
 * then closed to every new call at once and unmapped once the last running call has returned.
 */
class BinaryClosing {
  readonly #awaiting = new Set<string>();
  #unloaded = false;
  #closed = false;

  constructor(
    readonly library: koffi.IKoffiLib,
    readonly state: LoadState,
    readonly holdings: HandleHoldings,
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
    this.holdings.releaseAll();
    this.#closeIfFree();
  }

  close(): void {
    this.state.openToCalls = false;
    if (!this.#closed) {
      this.holdings.releaseAll();
      this.#closed = true;
      this.state.binaryOpen = false;
      if (this.state.running === 0) {
        this.#unmap();
      } else {
        this.state.whenIdle = () => this.#unmap();
      }
    }
  }

  #unmap(): void {
    this.state.whenIdle = undefined;
    this.state.mapped = false;
    this.library.unload();
    this.onClosed();
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
  declaration.services.forEach((service) => {
    optionalTextForC(service.description);
    service.functions.forEach((declared) => textForC(declared.symbol));
  });
  declaration.contracts?.forEach((contract) => textForC(contract.description));
}

/**
 * Binds every bytes function of a declaration the layer accepted, calls each definition's symbol once, and binds each
 * definition that declares a description from it, once `check` has passed it, and reads each contract it publishes
 * from its description, checked the same way.
 *
 * @param onClosed called once the binary is closed.
 * @throws Error when the file is missing, does not export a symbol the declaration names, a definition answers NULL or
 * a struct smaller than `2 * sizeof(void *)`, or a description is declared with no `check`, answers NULL, is refused
 * by the check or disagrees with this platform's layout; OutOfMemoryError for a check answering OUT_OF_MEMORY; the
 * binary is closed again before it throws.
 */
export function bindLibrary(
  path: string,
  declaration: LibraryDeclaration,
  onClosed: () => void = () => {},
  check?: DescriptionCheck,
): BoundLibrary {
  refuseTextsCutShort(path, declaration);
  if (!existsSync(path)) {
    throw new Error(`The C library ${declaration.importName} is not at ${path}.`);
  }
  const library = koffi.load(path);
  const state: LoadState = { openToCalls: true, binaryOpen: true, mapped: true, running: 0, whenIdle: undefined };
  const holdings = new HandleHoldings();
  let services: Map<string, LibraryService>;
  let definitions: Map<string, LibraryDefinition>;
  let described: Map<string, BoundDefinition>;
  let contracts: Map<string, readonly string[]>;
  try {
    let resolved: Map<string, ResolvedDefinition>;
    try {
      services = bindBytesServices(library, declaration, state);
      resolved = resolveDefinitions(library, declaration);
    } catch (error) {
      throw new Error(`The C library at ${path} does not export every symbol ${declaration.importName} declares.`, { cause: error });
    }
    definitions = readDefinitions(declaration.importName, resolved);
    described = bindDescribedDefinitions(library, declaration, definitions, check, { holdings, state });
    contracts = readContracts(library, declaration, check);
  } catch (error) {
    library.unload();
    throw error;
  }
  const closing = new BinaryClosing(library, state, holdings, onClosed);
  return {
    services,
    definitions,
    described,
    contracts,
    awaitRelease: (id) => closing.awaitRelease(id),
    released: (id) => closing.released(id),
    unload: () => closing.unload(),
    close: () => closing.close(),
  };
}
