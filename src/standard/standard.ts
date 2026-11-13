import { existsSync } from "node:fs";
import { join } from "node:path";
import koffi from "koffi";
import { Status } from "../core/constants.js";
import { sharedLibraryFileName } from "../core/library-file.js";
import { allocateSized, readStrings, type DecodedList } from "../core/memory.js";
import { encodeStrings, type Manifest } from "../core/values.js";
import {
  decodeStandardStruct,
  readDiscovery,
  readIdentity,
  readLibrary,
  readMirrorTemplates,
  readStandardRefusal,
  type DiscoveredPlugin,
  type Discovery,
  type Identity,
  type LibraryDeclaration,
  type ManifestAnswer,
  type StandardAnswer,
  type StandardRefusal,
  type ValidationOptions,
} from "./answers.js";
import { SHA256_BYTES, SHA256_HEX_LENGTH } from "./constants.js";
import {
  bindStandardFunctions,
  standardSizeOf,
  standardStructs,
  type StandardFunctions,
  type StandardStructName,
} from "./declarations.js";
import { copyManifestView } from "./manifest.js";

export interface StandardLibrary {
  readonly path: string;
  readonly functions: StandardFunctions;
}

/** The service ids the standard defines, as its library answers them. */
export interface StandardServiceIds {
  readonly config: string;
  readonly secrets: string;
  readonly paths: string;
}

/** The standard library the package's own build leaves in `native/`, beside the core. */
export function defaultStandardLibraryPath(): string {
  return join(import.meta.dirname, "..", "..", "native", sharedLibraryFileName("weivel_standard"));
}

const loadedLibraries = new Map<string, StandardLibrary>();

/** Loads and binds the standard library at `path`, once per path. */
export function loadStandardLibrary(path: string = defaultStandardLibraryPath()): StandardLibrary {
  const loaded = loadedLibraries.get(path);
  if (loaded !== undefined) {
    return loaded;
  }
  if (!existsSync(path)) {
    throw new Error(
      `The weivel standard library is not at ${path}. Build it with \`node scripts/native.ts\`, or pass the path of a built one.`,
    );
  }
  const library: StandardLibrary = { path, functions: bindStandardFunctions(koffi.load(path)) };
  loadedLibraries.set(path, library);
  return library;
}

export function loadStandard(path?: string): Standard {
  return new Standard(loadStandardLibrary(path));
}

/**
 * The manifest a discovered plugin is registered with: the standard's manifest, copied, carrying the identity file's
 * id. A plugin with no identity file keeps none, which is the host's to give.
 */
export function identifiedManifest(plugin: DiscoveredPlugin): Manifest {
  if (plugin.identityId === null) {
    return plugin.manifest;
  }
  return { ...plugin.manifest, identity: plugin.identityId };
}

function utf8(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

function encodeValidationOptions(options: ValidationOptions | undefined) {
  if (options === undefined) {
    return null;
  }
  return {
    size: standardSizeOf("weivel_standard_validation_options"),
    well_known_services: options.wellKnownServices === undefined ? null : [encodeStrings(options.wellKnownServices)],
  };
}

function answer<Value>(status: Status, value: Value | undefined, refusal: StandardRefusal | undefined): StandardAnswer<Value> {
  return { status, value: status === Status.Ok ? value : undefined, refusal };
}

/** Every default the standard ships, reached through one loaded standard library. */
export class Standard {
  readonly #functions: StandardFunctions;
  readonly path: string;
  readonly serviceIds: StandardServiceIds;

  constructor(library: StandardLibrary) {
    this.#functions = library.functions;
    this.path = library.path;
    this.serviceIds = {
      config: this.#functions.weivel_standard_service_config() as string,
      secrets: this.#functions.weivel_standard_service_secrets() as string,
      paths: this.#functions.weivel_standard_service_paths() as string,
    };
  }

  /** Validates a JSON manifest and, only when it is valid, reads it, as weivel_standard_load_manifest does. */
  loadManifest(json: string, options?: ValidationOptions): ManifestAnswer {
    const document = utf8(json);
    const loaded: unknown[] = [null];
    return this.#withStruct("weivel_standard_validation", "weivel_standard_validation_release", (validation) => {
      try {
        const status = this.#functions.weivel_standard_load_manifest(
          document,
          document.length,
          encodeValidationOptions(options),
          loaded,
          validation,
        ) as Status;
        const fields = decodeStandardStruct(validation, "weivel_standard_validation");
        const manifest = status === Status.Ok ? copyManifestView(this.#manifestView(loaded[0] as object)) : undefined;
        return {
          ...answer(status, manifest, readStandardRefusal(fields.refusal as Record<string, unknown>)),
          paths: readStrings(fields.paths as DecodedList),
        };
      } finally {
        this.#functions.weivel_standard_manifest_release(loaded[0]);
      }
    });
  }

  /** Scans one directory for plugins laid out by the standard, as weivel_standard_discover does. */
  discover(directory: string, options?: ValidationOptions): StandardAnswer<Discovery> {
    return this.#withStruct("weivel_standard_discovery", "weivel_standard_discovery_release", (discovery) => {
      const status = this.#functions.weivel_standard_discover(directory, encodeValidationOptions(options), discovery) as Status;
      const fields = decodeStandardStruct(discovery, "weivel_standard_discovery");
      const found = status === Status.Ok ? readDiscovery(fields, (manifest) => this.#manifestView(manifest)) : undefined;
      return answer(status, found, readStandardRefusal(fields.refusal as Record<string, unknown>));
    });
  }

  parseIdentity(text: string): StandardAnswer<Identity> {
    return this.#withParsedIdentity(text, (identity) => readIdentity(decodeStandardStruct(identity, "weivel_standard_identity")));
  }

  /**
   * Orders two identities as weivel_standard_identity_compare does: below zero, zero or above zero. The first that
   * is not an identity answers its refusal instead.
   */
  compareIdentities(left: string, right: string): StandardAnswer<number> {
    const compared = this.#withParsedIdentity(left, (leftIdentity) =>
      this.#withParsedIdentity(right, (rightIdentity) =>
        this.#functions.weivel_standard_identity_compare(leftIdentity, rightIdentity) as number,
      ),
    );
    return compared.value ?? { status: compared.status, value: undefined, refusal: compared.refusal };
  }

  /** Reads a C library's declaration, which the host binds. */
  readLibrary(json: string): StandardAnswer<LibraryDeclaration> {
    const document = utf8(json);
    return this.#withStructAndRefusal("weivel_standard_library", "weivel_standard_library_release", (library, refusal) => {
      const status = this.#functions.weivel_standard_read_library(document, document.length, library, refusal) as Status;
      return { status, value: readLibrary(decodeStandardStruct(library, "weivel_standard_library")) };
    });
  }

  readMirrors(json: string): StandardAnswer<string[]> {
    const document = utf8(json);
    return this.#withMirrorList((list, refusal) =>
      this.#functions.weivel_standard_read_mirrors(document, document.length, list, refusal) as Status,
    );
  }

  loadMirrors(path: string): StandardAnswer<string[]> {
    return this.#withMirrorList((list, refusal) => this.#functions.weivel_standard_load_mirrors(path, list, refusal) as Status);
  }

  /** A mirror template with its placeholder replaced by `hashHex`, as weivel_standard_mirror_expand answers it. */
  expandMirror(template: string, hashHex: string): StandardAnswer<string> {
    const expanded: unknown[] = [null];
    return this.#withRefusal((refusal) => {
      try {
        const status = this.#functions.weivel_standard_mirror_expand(template, hashHex, expanded, refusal) as Status;
        const url = expanded[0] === null ? undefined : (koffi.decode(expanded[0], "char", -1) as string);
        return { status, value: url };
      } finally {
        this.#functions.weivel_standard_text_release(expanded[0]);
      }
    });
  }

  sha256(bytes: Uint8Array): Uint8Array {
    const digest = Buffer.alloc(SHA256_BYTES);
    this.#functions.weivel_standard_sha256(bytes, bytes.length, digest);
    return new Uint8Array(digest);
  }

  sha256Hex(bytes: Uint8Array): string {
    const digest = Buffer.alloc(SHA256_HEX_LENGTH + 1);
    this.#functions.weivel_standard_sha256_hex(bytes, bytes.length, digest);
    return digest.toString("latin1", 0, SHA256_HEX_LENGTH);
  }

  isSha256Hex(text: string): boolean {
    return this.#functions.weivel_standard_is_sha256_hex(text) === 1;
  }

  /** Checks a download against the SHA-256 that was asked for; the standard never fetches. */
  verifyDownload(bytes: Uint8Array, expectedHex: string): StandardAnswer<undefined> {
    return this.#withRefusal((refusal) => ({
      status: this.#functions.weivel_standard_verify_download(bytes, bytes.length, expectedHex, refusal) as Status,
      value: undefined,
    }));
  }

  #manifestView(manifest: object): object {
    return this.#functions.weivel_standard_manifest_view(manifest) as object;
  }

  #withStruct<Value>(name: StandardStructName, release: keyof StandardFunctions, use: (pointer: object) => Value): Value {
    const pointer = allocateSized(standardStructs[name]);
    try {
      return use(pointer);
    } finally {
      this.#functions[release](pointer);
      koffi.free(pointer);
    }
  }

  #withRefusal<Value>(call: (refusal: object) => { status: Status; value: Value | undefined }): StandardAnswer<Value> {
    return this.#withStruct("weivel_standard_refusal", "weivel_standard_refusal_release", (refusal) => {
      const { status, value } = call(refusal);
      return answer(status, value, readStandardRefusal(decodeStandardStruct(refusal, "weivel_standard_refusal")));
    });
  }

  #withStructAndRefusal<Value>(
    name: StandardStructName,
    release: keyof StandardFunctions,
    call: (pointer: object, refusal: object) => { status: Status; value: Value | undefined },
  ): StandardAnswer<Value> {
    return this.#withStruct(name, release, (pointer) => this.#withRefusal((refusal) => call(pointer, refusal)));
  }

  #withMirrorList(call: (list: object, refusal: object) => Status): StandardAnswer<string[]> {
    return this.#withStructAndRefusal("weivel_standard_mirror_list", "weivel_standard_mirror_list_release", (list, refusal) => {
      const status = call(list, refusal);
      return { status, value: readMirrorTemplates(decodeStandardStruct(list, "weivel_standard_mirror_list")) };
    });
  }

  #withParsedIdentity<Value>(text: string, use: (identity: object) => Value): StandardAnswer<Value> {
    const bytes = utf8(text);
    return this.#withStructAndRefusal("weivel_standard_identity", "weivel_standard_identity_release", (identity, refusal) => {
      const status = this.#functions.weivel_standard_identity_parse(bytes, bytes.length, identity, refusal) as Status;
      return { status, value: status === Status.Ok ? use(identity) : undefined };
    });
  }
}
