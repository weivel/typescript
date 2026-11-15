import koffi from "koffi";
import { RefusalError, type PluginContext } from "../context/index.js";
import type { LibraryDefinition, LibraryService, LoadedLibrary } from "../host/index.js";
import type { LibraryDeclaration } from "../standard/answers.js";
import { FunctionKind } from "../standard/constants.js";
import { refuseUnknownKeys, type Observer } from "./expectations.js";
import type { LayerVector } from "./vectors.js";
import { alive, inertEntry, settled, type BuiltPlugin, type DriverWorld } from "./world.js";

interface GivenFunction {
  readonly name: string;
  readonly symbol: string;
  readonly kind: string;
}

interface GivenDeclaration {
  readonly importName: string;
  readonly version: string;
  readonly release?: string;
  readonly services: readonly { readonly id: string; readonly functions: readonly GivenFunction[] }[];
}

type Step =
  | { readonly load: true }
  | { readonly holder: string; readonly get: string }
  | { readonly holder: string; readonly echo: string }
  | { readonly holder: string; readonly call: string; readonly function: string; readonly text: string; readonly keep: true }
  | { readonly holder: string; readonly drop: string }
  | { readonly holder: string; readonly countUnloads: true }
  | { readonly unload: true }
  | { readonly holder: string; readonly releaseHolding: string }
  | { readonly releaseHolder: string }
  | { readonly quarantine: string }
  | { readonly readUnloads: true };

interface LibraryGiven {
  readonly declaration: GivenDeclaration;
  readonly holders: readonly string[];
  readonly steps: readonly Step[];
}

const kinds: Readonly<Record<string, number>> = { bytes: FunctionKind.Bytes, definition: FunctionKind.Definition };
const stepKeys = ["load", "get", "echo", "call", "drop", "countUnloads", "unload", "releaseHolding", "releaseHolder", "quarantine", "readUnloads"] as const;
const stepFields: Readonly<Record<(typeof stepKeys)[number], readonly string[]>> = {
  load: ["load"],
  get: ["holder", "get"],
  echo: ["holder", "echo"],
  call: ["holder", "call", "function", "text", "keep"],
  drop: ["holder", "drop"],
  countUnloads: ["holder", "countUnloads"],
  unload: ["unload"],
  releaseHolding: ["holder", "releaseHolding"],
  releaseHolder: ["releaseHolder"],
  quarantine: ["quarantine"],
  readUnloads: ["readUnloads"],
};

/** A capability every holder declares and never provides, so the host's verification of it is refused. */
const neverProvided = "never-provided";

/** The head of the echo library's `echo_definition`, as its `test/echo/echo.h` lays it out. */
const echoDefinition = koffi.struct({ size: "uint32_t", context: "void *", echo: "void *", release: "void *", count_unloads: "void *" });
const echoOperation = koffi.proto("int32_t", ["void *", "const void *", "size_t", "_Out_ void **", "_Out_ size_t *"]);
const releaseOperation = koffi.proto("void", ["void *", "void *"]);
const countUnloadsOperation = koffi.proto("void", ["void *", "void *"]);

/**
 * Every counter handed to an echo binary, never freed.
 *
 * @implNote The binary writes its counter when it is closed, which for a layer that never closes it is at process
 * exit, so the counter's memory must outlive every run.
 */
const unloadCounters: object[] = [];

function checkGiven(vector: LayerVector): LibraryGiven {
  refuseUnknownKeys(`The vector ${vector.id}'s given`, vector.given, ["declaration", "holders", "steps"]);
  const given = vector.given as unknown as LibraryGiven;
  given.steps.forEach((step, index) => {
    const where = `The vector ${vector.id}'s step ${index}`;
    const named = stepKeys.filter((key) => key in step);
    if (named.length !== 1) {
      throw new Error(`${where} names ${named.length} actions; a step names exactly one of ${stepKeys.join(", ")}.`);
    }
    refuseUnknownKeys(where, step, stepFields[named[0]!]);
  });
  return given;
}

/** The declaration as the suite builds it, each kind read by the standard's constant and no function given context facts. */
function declarationOf(given: GivenDeclaration): LibraryDeclaration {
  return {
    importName: given.importName,
    version: given.version,
    release: given.release ?? null,
    services: given.services.map((service) => ({
      id: service.id,
      functions: service.functions.map((declared) => {
        const kind = kinds[declared.kind];
        if (kind === undefined) {
          throw new Error(`The declaration names the kind ${declared.kind}, which this driver does not know.`);
        }
        return { name: declared.name, symbol: declared.symbol, kind, context: 0 };
      }),
    })),
  };
}

function isDefinition(object: unknown): object is LibraryDefinition {
  return typeof object === "object" && object !== null && "pointer" in object && "library" in object;
}

function definitionOperations(definition: LibraryDefinition): Record<string, unknown> {
  return koffi.decode(definition.pointer, echoDefinition) as Record<string, unknown>;
}

class LibraryRun {
  readonly got: boolean[] = [];
  readonly echoed: string[] = [];
  readonly revoked: [string, string][] = [];
  readonly unloads: number[] = [];
  loaded = false;
  callersMistake = false;
  readonly #declaration: LibraryDeclaration;
  readonly #contexts = new Map<string, PluginContext>();
  /** Each holder's latest resolved object, by `<holder> <id>`. */
  readonly #resolved = new Map<string, unknown>();
  /** Each definition id's address as the suite read it from the binary itself. */
  readonly #addresses = new Map<string, bigint>();
  /** Every definition a get served, with its id. */
  readonly #servedDefinitions: [string, unknown][] = [];
  readonly #releases = new Map<string, () => void>();
  readonly #kept = new Map<string, Uint8Array>();
  #library: LoadedLibrary | undefined;
  #counter: object | undefined;

  constructor(
    readonly world: DriverWorld,
    readonly echoLibraryPath: string,
    readonly given: LibraryGiven,
    readonly readsAddresses: boolean,
  ) {
    this.#declaration = declarationOf(given.declaration);
    world.register(given.holders.map((holder) => this.#holder(holder)));
    for (const holder of given.holders) {
      const context = world.open(holder);
      context.events.listen((event) => {
        if (event.kind === "revoked") {
          this.revoked.push([holder, event.id]);
          this.#releases.set(`${holder} ${event.id}`, () => event.release());
        }
      });
      this.#contexts.set(holder, context);
    }
  }

  #holder(holder: string): BuiltPlugin {
    const ids = this.given.declaration.services.map((service) => ({ id: service.id }));
    return {
      manifest: {
        importName: holder,
        api: 1,
        entry: `${holder}.ts`,
        services: { consumes: ids },
        capabilities: { provides: [neverProvided], consumes: [] },
      },
      entry: inertEntry,
    };
  }

  async run(step: Step): Promise<void> {
    await this.#perform(step);
    await settled();
  }

  async #perform(step: Step): Promise<void> {
    if ("load" in step) {
      this.#load();
    } else if ("get" in step) {
      this.#get(step.holder, step.get);
    } else if ("echo" in step) {
      this.echoed.push(this.#echo(this.#definitionOf(step.holder), step.echo));
    } else if ("call" in step) {
      const service = this.#resolvedOf(step.holder, step.call) as LibraryService;
      this.#kept.set(`${step.holder} ${step.call}`, service[step.function]!(new TextEncoder().encode(step.text)));
    } else if ("drop" in step) {
      this.#kept.delete(`${step.holder} ${step.drop}`);
    } else if ("countUnloads" in step) {
      this.#countUnloads(this.#definitionOf(step.holder));
    } else {
      await this.#performHostStep(step);
    }
  }

  async #performHostStep(step: Step): Promise<void> {
    if ("unload" in step) {
      this.#library?.unload();
    } else if ("releaseHolding" in step) {
      const release = this.#releases.get(`${step.holder} ${step.releaseHolding}`);
      if (release === undefined) {
        throw new Error(`${step.holder} was never told ${step.releaseHolding} was revoked, so it holds nothing to release.`);
      }
      release();
    } else if ("releaseHolder" in step) {
      await this.world.host.release(this.world.plugin(step.releaseHolder));
    } else if ("quarantine" in step) {
      this.#quarantine(step.quarantine);
    } else if ("readUnloads" in step) {
      if (this.#counter === undefined) {
        throw new Error("The vector reads the unload counter before any holder handed it to the binary.");
      }
      this.unloads.push(Number(koffi.decode(this.#counter, "uint64_t") as bigint | number));
    }
  }

  #load(): void {
    try {
      this.#library = alive(this.world.host.loadLibrary(this.#declaration, this.echoLibraryPath));
      this.loaded = true;
    } catch (error) {
      this.callersMistake = !(error instanceof RefusalError);
      return;
    }
    if (this.readsAddresses) {
      this.#readAddresses();
    }
  }

  /**
   * Reads each definition's address by calling its symbol on a handle of the suite's own, opened while the layer holds
   * the binary, so it is the same mapping, and closed again before the next step.
   */
  #readAddresses(): void {
    const binary = koffi.load(this.echoLibraryPath);
    try {
      for (const service of this.#declaration.services) {
        const definition = service.functions.find((declared) => declared.kind === FunctionKind.Definition);
        if (definition !== undefined) {
          const answered = (binary.func(definition.symbol, "void *", []) as () => object | null)();
          this.#addresses.set(service.id, answered === null ? 0n : koffi.address(answered));
        }
      }
    } finally {
      binary.unload();
    }
  }

  #get(holder: string, id: string): void {
    const context = this.#contextOf(holder);
    const object = context.services.get(context.service(id));
    this.got.push(object !== undefined);
    if (object !== undefined) {
      this.#resolved.set(`${holder} ${id}`, object);
      if (this.#declaresDefinition(id)) {
        this.#servedDefinitions.push([id, object]);
      }
    }
  }

  #declaresDefinition(id: string): boolean {
    return this.#declaration.services.some((service) => service.id === id && service.functions.some((declared) => declared.kind === FunctionKind.Definition));
  }

  #echo(definition: LibraryDefinition, text: string): string {
    const operations = definitionOperations(definition);
    const input = new TextEncoder().encode(text);
    const output: (object | null)[] = [null];
    const outputLength: number[] = [0];
    const status = koffi.call(operations.echo, echoOperation, operations.context, input, input.length, output, outputLength) as number;
    try {
      const answered = output[0] === null || output[0] === undefined ? new Uint8Array(0) : new Uint8Array(koffi.view(output[0], Number(outputLength[0])));
      return status === 0 ? new TextDecoder().decode(answered) : `status ${status}`;
    } finally {
      if (output[0] !== null && output[0] !== undefined) {
        koffi.call(operations.release, releaseOperation, operations.context, output[0]);
      }
    }
  }

  #countUnloads(definition: LibraryDefinition): void {
    const operations = definitionOperations(definition);
    const counter = koffi.alloc("uint64_t", 1) as object;
    koffi.encode(counter, "uint64_t", 0);
    unloadCounters.push(counter);
    koffi.call(operations.count_unloads, countUnloadsOperation, operations.context, counter);
    this.#counter = counter;
  }

  #quarantine(holder: string): void {
    const outcome = alive(this.world.host.verify(this.world.plugin(holder)));
    if (outcome.state !== "quarantined") {
      throw new Error(`The host's verification of ${holder} answered ${outcome.state}, so it was not quarantined.`);
    }
  }

  #definitionOf(holder: string): LibraryDefinition {
    const definition = [...this.#resolved].reverse().find(([key, object]) => key.startsWith(`${holder} `) && isDefinition(object))?.[1];
    if (definition === undefined) {
      throw new Error(`${holder} resolved no definition.`);
    }
    return definition as LibraryDefinition;
  }

  #resolvedOf(holder: string, id: string): unknown {
    const object = this.#resolved.get(`${holder} ${id}`);
    if (object === undefined) {
      throw new Error(`${holder} never resolved ${id}.`);
    }
    return object;
  }

  #contextOf(holder: string): PluginContext {
    const context = this.#contexts.get(holder);
    if (context === undefined) {
      throw new Error(`A step names a holder the vector does not give: ${holder}.`);
    }
    return context;
  }

  #sameObject(): boolean {
    return (
      this.#servedDefinitions.length > 0 &&
      this.#servedDefinitions.every(([id, object]) => isDefinition(object) && koffi.address(object.pointer) === this.#addresses.get(id))
    );
  }

  observers(): Record<string, Observer> {
    return {
      loaded: () => this.loaded,
      callersMistake: () => this.callersMistake,
      got: () => [...this.got],
      sameObject: () => this.#sameObject(),
      echoed: () => [...this.echoed],
      revoked: () => [...this.revoked].sort(([holderA, idA], [holderB, idB]) => holderA.localeCompare(holderB) || idA.localeCompare(idB)),
      unloads: () => [...this.unloads],
      reported: () => [
        ...this.world.logs.map((entry) => `${entry.source} ${entry.level} ${entry.message}`),
        ...this.world.sunk.map((error) => (error instanceof Error ? error.message : String(error))),
      ],
    };
  }
}

/**
 * Loads the vector's declaration through the host with the echo library beside it, drives its steps in order, and
 * answers what the run shows.
 *
 * @throws Error when the driver was given no echo library.
 */
export async function driveLibrary(vector: LayerVector, world: DriverWorld, echoLibraryPath: string | undefined): Promise<Record<string, Observer>> {
  if (echoLibraryPath === undefined) {
    throw new Error(`The vector ${vector.id} loads the core's echo library, and the driver was given no echoLibraryPath.`);
  }
  const given = checkGiven(vector);
  const run = new LibraryRun(world, echoLibraryPath, given, "sameObject" in vector.then);
  for (const step of given.steps) {
    await run.run(step);
  }
  return run.observers();
}
