import koffi from "koffi";
import type { Status } from "../core/constants.js";
import { readStrings, type DecodedList, type NativePointer } from "../core/memory.js";
import type { Manifest } from "../core/values.js";
import { StandardRefusalCode, type FunctionKind, type IdentityKind } from "./constants.js";
import { standardStructs, type StandardStructName } from "./declarations.js";
import { copyManifestView } from "./manifest.js";

type DecodedFields = Record<string, unknown>;

/** A refusal as the standard answered it, its `path` exactly as the standard wrote it. */
export interface StandardRefusal {
  readonly code: StandardRefusalCode;
  readonly detail: string | null;
  readonly fix: string | null;
  /** The field refused, as `services.provides[0].attributes["a.b"]`; empty for the whole document. */
  readonly path: string;
}

/** What one call of the standard answered: its status, its value on OK, and its refusal when it made one. */
export interface StandardAnswer<Value> {
  readonly status: Status;
  readonly value: Value | undefined;
  readonly refusal: StandardRefusal | undefined;
}

/** A loaded manifest's answer: beside the refusal, every field validation found wrong, in the standard's order. */
export interface ManifestAnswer extends StandardAnswer<Manifest> {
  readonly paths: readonly string[];
}

export interface ValidationOptions {
  /** The host's well-known service ids for rule V2; left out, V2 is not applied. */
  readonly wellKnownServices?: readonly string[];
}

/** A repository identity taken apart; the fields a kind does not use are null, and `number` is 0n for a local one. */
export interface Identity {
  readonly kind: IdentityKind;
  readonly name: string | null;
  readonly forge: string | null;
  readonly host: string | null;
  readonly number: bigint;
  readonly segments: readonly string[];
}

export interface DiscoveredPlugin {
  /** The manifest as the standard loaded it, with no identity: the identity file's id is the host's to set. */
  readonly manifest: Manifest;
  readonly manifestPath: string;
  readonly identityPath: string | null;
  readonly identityId: string | null;
  readonly repositoryName: string | null;
  readonly identity: Identity | null;
  readonly entryPath: string | null;
  readonly entryPresent: boolean;
}

export interface DiscoveryFailure {
  readonly file: string;
  readonly refusal: StandardRefusal;
}

/** One scan of a directory, plugins and failures in the standard's order. */
export interface Discovery {
  readonly plugins: readonly DiscoveredPlugin[];
  readonly failures: readonly DiscoveryFailure[];
}

export interface LibraryFunction {
  readonly name: string;
  readonly symbol: string;
  readonly kind: FunctionKind;
  /** The process facts the function reads, as ContextFact bits. */
  readonly context: number;
}

export interface LibraryService {
  readonly id: string;
  readonly functions: readonly LibraryFunction[];
}

/** A C library's declaration as the standard read it. */
export interface LibraryDeclaration {
  readonly importName: string;
  readonly version: string;
  readonly release: string;
  readonly services: readonly LibraryService[];
}

export function decodeStandardStruct(pointer: object, name: StandardStructName): DecodedFields {
  return koffi.decode(pointer, standardStructs[name]) as DecodedFields;
}

/** Reads a decoded weivel_standard_refusal; an empty one, code NONE, is no refusal. */
export function readStandardRefusal(fields: DecodedFields): StandardRefusal | undefined {
  if (fields.code === StandardRefusalCode.None) {
    return undefined;
  }
  return {
    code: fields.code as StandardRefusalCode,
    detail: fields.detail as string | null,
    fix: fields.fix as string | null,
    path: (fields.path as string | null) ?? "",
  };
}

/** Reads an array whose elements never grow, at this layer's own stride, as the standard's headers require. */
function readFixedElements(items: NativePointer, count: number, name: StandardStructName): DecodedFields[] {
  if (items === null) {
    return [];
  }
  const stride = koffi.sizeof(standardStructs[name]);
  return Array.from({ length: count }, (_, index) => koffi.decode(items, index * stride, standardStructs[name]) as DecodedFields);
}

function readBytesAsText(pointer: NativePointer, length: number): string | null {
  if (pointer === null) {
    return null;
  }
  const bytes = koffi.decode(pointer, 0, "uint8_t", length) as number[];
  return Buffer.from(bytes).toString("utf8");
}

export function readIdentity(fields: DecodedFields): Identity {
  return {
    kind: fields.kind as IdentityKind,
    name: readBytesAsText(fields.name as NativePointer, Number(fields.name_length)),
    forge: fields.forge as string | null,
    host: fields.host as string | null,
    number: BigInt(fields.number as number | bigint),
    segments: readStrings({ items: fields.segments as NativePointer, count: Number(fields.segment_count) } as DecodedList),
  };
}

function readDiscoveredPlugin(fields: DecodedFields, manifestView: (manifest: object) => object): DiscoveredPlugin {
  const identityPath = fields.identity_path as string | null;
  return {
    manifest: copyManifestView(manifestView(fields.manifest as object)),
    manifestPath: fields.manifest_path as string,
    identityPath,
    identityId: fields.identity_id as string | null,
    repositoryName: fields.repository_name as string | null,
    identity: identityPath === null ? null : readIdentity(fields.identity as DecodedFields),
    entryPath: fields.entry_path as string | null,
    entryPresent: fields.entry_present === 1,
  };
}

function readDiscoveryFailure(fields: DecodedFields): DiscoveryFailure {
  return { file: fields.file as string, refusal: readStandardRefusal(fields.refusal as DecodedFields)! };
}

export function readDiscovery(fields: DecodedFields, manifestView: (manifest: object) => object): Discovery {
  return {
    plugins: readFixedElements(
      fields.plugins as NativePointer,
      Number(fields.plugin_count),
      "weivel_standard_discovered_plugin",
    ).map((plugin) => readDiscoveredPlugin(plugin, manifestView)),
    failures: readFixedElements(
      fields.failures as NativePointer,
      Number(fields.failure_count),
      "weivel_standard_discovery_failure",
    ).map(readDiscoveryFailure),
  };
}

function readLibraryFunction(fields: DecodedFields): LibraryFunction {
  return {
    name: fields.name as string,
    symbol: fields.symbol as string,
    kind: fields.kind as FunctionKind,
    context: fields.context as number,
  };
}

function readLibraryService(fields: DecodedFields): LibraryService {
  return {
    id: fields.id as string,
    functions: readFixedElements(
      fields.functions as NativePointer,
      Number(fields.function_count),
      "weivel_standard_library_function",
    ).map(readLibraryFunction),
  };
}

export function readLibrary(fields: DecodedFields): LibraryDeclaration {
  return {
    importName: fields.import_name as string,
    version: fields.version as string,
    release: fields.release as string,
    services: readFixedElements(
      fields.services as NativePointer,
      Number(fields.service_count),
      "weivel_standard_library_service",
    ).map(readLibraryService),
  };
}

export function readMirrorTemplates(fields: DecodedFields): string[] {
  return readStrings({ items: fields.templates as NativePointer, count: Number(fields.count) } as DecodedList);
}
