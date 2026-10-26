import koffi from "koffi";
import { pluginError } from "../../engine/index.js";
import type { PluginError } from "../../index.js";
import type { LibraryDeclaration } from "./declaration.js";

/** An address inside the library, which the host never dereferences beyond copying a result out. */
export type NativePointer = unknown;

/** The library's own release function, the only thing allowed to free what it returned. */
export type ReleaseFunction = (pointer: NativePointer) => void;

/** Test seams into the bridge; a host passes none. */
export interface BridgeSeams {
  /** Wraps the bound release function, so a test can observe every release. */
  wrapRelease?: (release: ReleaseFunction) => ReleaseFunction;
}

/** An opened library: every declared symbol bound, callable by symbol until closed. */
export interface LoadedLibrary {
  /** Calls one declared `json` function with a JSON value, answering its JSON result or throwing a `PluginError`. */
  call(symbol: string, argument: unknown): unknown;
  /** Unloads the binary; a later call is refused rather than reaching unloaded code. */
  close(): void;
}

type JsonFunction = (input: Uint8Array, inputLength: number, out: [NativePointer], outLength: [number | bigint]) => number;

interface BoundFunction {
  label: string;
  native: JsonFunction;
}

/**
 * The one native signature of the `json` kind, `int32_t f(const uint8_t *in, size_t in_len,
 * uint8_t **out, size_t *out_len)`, declared once and bound to every symbol of that kind.
 */
const JSON_KIND_RESULT = "int32_t";
const JSON_KIND_PARAMETERS = ["const uint8_t *", "size_t", "_Out_ uint8_t **", "_Out_ size_t *"];
const RELEASE_RESULT = "void";
const RELEASE_PARAMETERS = ["uint8_t *"];

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
const UTF8 = new TextEncoder();

function loadBinary(binaryPath: string, libraryId: string): koffi.IKoffiLib {
  try {
    return koffi.load(binaryPath);
  } catch (error) {
    throw pluginError(libraryId, `${binaryPath} could not be loaded: ${(error as Error).message}`, "rebuild the library for this platform and publish it again");
  }
}

function bindSymbol(native: koffi.IKoffiLib, libraryId: string, symbol: string, result: string, parameters: string[]): unknown {
  try {
    return native.func(symbol, result, parameters);
  } catch (error) {
    throw pluginError(
      libraryId,
      `the binary exports no symbol ${symbol}, which its declaration names: ${(error as Error).message}`,
      `export ${symbol} from the library, or remove it from library.json`,
    );
  }
}

function bindDeclared(native: koffi.IKoffiLib, declaration: LibraryDeclaration): Map<string, BoundFunction> {
  const bound = new Map<string, BoundFunction>();
  for (const service of declaration.services) {
    for (const fn of service.functions) {
      const nativeFunction = bindSymbol(native, declaration.id, fn.symbol, JSON_KIND_RESULT, JSON_KIND_PARAMETERS) as JsonFunction;
      bound.set(fn.symbol, { label: `${service.id}.${fn.name}`, native: nativeFunction });
    }
  }
  return bound;
}

function encodeArgument(libraryId: string, label: string, argument: unknown): Uint8Array {
  let text: string | undefined;
  try {
    text = JSON.stringify(argument ?? null);
  } catch (error) {
    throw pluginError(libraryId, `${label} was called with an argument that is not JSON: ${(error as Error).message}`, "pass plain JSON data");
  }
  return UTF8.encode(text ?? "null");
}

/**
 * @implNote koffi 2.16.3 writes a NULL `_Out_ uint8_t **` back as `null`, overwriting whatever the
 * out array held (measured through `_dupenv_s`); the zero-address check covers a NULL that reaches
 * the host as an External instead.
 */
function isNullPointer(pointer: NativePointer): boolean {
  return pointer === null || pointer === undefined || koffi.address(pointer) === 0n;
}

/**
 * Copies a library-owned result into host memory, then hands it back to the library's release.
 *
 * @remarks
 * A null pointer is never released: it is how a library that could not allocate its own answer
 * reports a failure, and there is nothing of its to free.
 */
function takeResult(pointer: NativePointer, length: number | bigint, release: ReleaseFunction): Uint8Array | null {
  if (isNullPointer(pointer)) return null;
  try {
    const byteCount = Number(length);
    return byteCount === 0 ? new Uint8Array(0) : Uint8Array.from(koffi.decode(pointer, "uint8_t", byteCount) as ArrayLike<number>);
  } finally {
    release(pointer);
  }
}

function jsonOf(libraryId: string, label: string, bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = STRICT_UTF8.decode(bytes);
  } catch {
    throw pluginError(libraryId, `${label} answered bytes that are not UTF-8`, `report it to the maintainers of ${libraryId}: its answers must be UTF-8 JSON`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw pluginError(libraryId, `${label} answered text that is not JSON`, `report it to the maintainers of ${libraryId}: its answers must be UTF-8 JSON`);
  }
}

function failureOf(libraryId: string, label: string, status: number, answer: unknown): PluginError {
  const { message, fix } = (typeof answer === "object" && answer !== null ? answer : {}) as { message?: unknown; fix?: unknown };
  if (typeof message === "string" && typeof fix === "string") return pluginError(libraryId, `${label}: ${message}`, fix);
  return pluginError(libraryId, `${label} failed with status ${status} and no {message, fix} object`, `report it to the maintainers of ${libraryId}: a failure must say what went wrong and how to fix it`);
}

function missingAnswer(libraryId: string, label: string, status: number): PluginError {
  if (status === 0) {
    return pluginError(libraryId, `${label} reported success but returned no answer`, `report it to the maintainers of ${libraryId}: a success must carry its JSON result`);
  }
  return pluginError(libraryId, `${label} failed with status ${status} and returned no answer`, "the library could not allocate its answer; retry the call");
}

function answerOf(libraryId: string, label: string, status: number, bytes: Uint8Array | null): unknown {
  if (bytes === null) throw missingAnswer(libraryId, label, status);
  const answer = jsonOf(libraryId, label, bytes);
  if (status !== 0) throw failureOf(libraryId, label, status, answer);
  return answer;
}

/**
 * Opens a verified binary and binds every symbol its declaration names, refusing at open any it lacks.
 *
 * @remarks
 * Every result is copied out of library memory before the library's release function frees it,
 * in a `finally`, so a result that turns out not to be UTF-8 or JSON is still released exactly once.
 */
export function openLibrary(binaryPath: string, declaration: LibraryDeclaration, seams: BridgeSeams = {}): LoadedLibrary {
  const native = loadBinary(binaryPath, declaration.id);
  let release: ReleaseFunction;
  let functions: Map<string, BoundFunction>;
  try {
    const boundRelease = bindSymbol(native, declaration.id, declaration.release, RELEASE_RESULT, RELEASE_PARAMETERS) as ReleaseFunction;
    release = seams.wrapRelease ? seams.wrapRelease(boundRelease) : boundRelease;
    functions = bindDeclared(native, declaration);
  } catch (error) {
    native.unload();
    throw error;
  }

  let closed = false;
  return {
    call(symbol: string, argument: unknown): unknown {
      const bound = functions.get(symbol);
      if (closed || !bound) {
        const reason = closed ? "the library is closed" : `${symbol} is not a declared function`;
        throw pluginError(declaration.id, `${symbol} cannot be called: ${reason}`, "call a declared function of an open library");
      }
      const out: [NativePointer] = [null];
      const outLength: [number | bigint] = [0];
      const input = encodeArgument(declaration.id, bound.label, argument);
      const status = bound.native(input, input.length, out, outLength);
      return answerOf(declaration.id, bound.label, status, takeResult(out[0], outLength[0], release));
    },
    close(): void {
      if (closed) return;
      closed = true;
      native.unload();
    },
  };
}
