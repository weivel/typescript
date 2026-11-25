import koffi from "koffi";
import { Status } from "../core/constants.js";
import { RefusalError, type PluginContext } from "../context/index.js";
import { EmbeddedNulError } from "../core/text.js";
import { blockingOperationsOf, boundDefinitionOf, DescribedCallError, none, OperationNotOfferedError, OutOfMemoryError, type DescribedHandle, type LoadedLibrary } from "../host/index.js";
import { DescribedKind, DescribedRole } from "../host/description/layout.js";
import { readDescription, type Description, type DescribedType } from "../host/description/reader.js";
import type { LibraryContract, LibraryDeclaration } from "../standard/answers.js";
import { FunctionKind } from "../standard/constants.js";
import { refuseUnknownKeys, type Observer } from "./expectations.js";
import type { LayerVector } from "./vectors.js";
import { alive, inertEntry, type BuiltPlugin, type DriverWorld } from "./world.js";

interface GivenService {
  readonly id: string;
  readonly description?: string;
  readonly functions: readonly { readonly name: string; readonly symbol: string; readonly kind: string }[];
}

interface GivenDeclaration {
  readonly importName: string;
  readonly version: string;
  readonly services?: readonly GivenService[];
  readonly contracts?: readonly LibraryContract[];
}

type Step =
  | { readonly load: true }
  | { readonly holder: string; readonly get: string }
  | { readonly holder: string; readonly call: string; readonly operation: string; readonly with?: Record<string, unknown>; readonly keep?: string }
  | { readonly holder: string; readonly release: string }
  | { readonly holder: string; readonly blocking: string }
  | { readonly holder: string; readonly readReleases: true }
  | { readonly unload: true };

interface DescriptionGiven {
  readonly declaration: GivenDeclaration;
  readonly holders: readonly string[];
  readonly steps: readonly Step[];
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const stepFields: Readonly<Record<string, readonly string[]>> = {
  load: ["load"],
  get: ["holder", "get"],
  call: ["holder", "call", "operation", "with", "keep"],
  release: ["holder", "release"],
  blocking: ["holder", "blocking"],
  readReleases: ["holder", "readReleases"],
  unload: ["unload"],
};

/** A capability every holder declares and never provides, as in a `library` vector. */
const neverProvided = "never-provided";

const statusNames: Readonly<Record<number, string>> = Object.fromEntries(
  Object.entries(Status).map(([name, value]) => [value, name.replace(/[A-Z]/g, (letter, at: number) => `${at === 0 ? "" : "_"}${letter.toLowerCase()}`)]),
);

const integerKinds: readonly number[] = [DescribedKind.U64, DescribedKind.I64, DescribedKind.Size];

function checkGiven(vector: LayerVector): DescriptionGiven {
  refuseUnknownKeys(`The vector ${vector.id}'s given`, vector.given, ["declaration", "holders", "steps"]);
  const given = vector.given as unknown as DescriptionGiven;
  given.steps.forEach((step, index) => {
    const where = `The vector ${vector.id}'s step ${index}`;
    const named = Object.keys(stepFields).filter((key) => key in step);
    if (named.length !== 1) {
      throw new Error(`${where} names ${named.length} actions; a step names exactly one of ${Object.keys(stepFields).join(", ")}.`);
    }
    refuseUnknownKeys(where, step, stepFields[named[0]!]!);
  });
  return given;
}

function declarationOf(given: GivenDeclaration): LibraryDeclaration {
  return {
    importName: given.importName,
    version: given.version,
    release: null,
    services: (given.services ?? []).map((service) => ({
      id: service.id,
      functions: service.functions.map((declared) => {
        if (declared.kind !== "definition") {
          throw new Error(`The declaration names the kind ${declared.kind}, and a description vector declares definitions alone.`);
        }
        return { name: declared.name, symbol: declared.symbol, kind: FunctionKind.Definition, context: 0 };
      }),
      ...(service.description === undefined ? {} : { description: service.description }),
    })),
    ...(given.contracts === undefined ? {} : { contracts: given.contracts }),
  };
}

/** The described struct `name` of `description`. */
function typeOf(description: Description, name: string | null): DescribedType {
  const type = description.types.find((candidate) => candidate.name === name);
  if (type === undefined) {
    throw new Error(`The description of ${description.definition} holds no struct ${name}.`);
  }
  return type;
}

/** A definition an answer carried, kept under the name its step's `keep` gave, with the answer that carried it. */
interface KeptDefinition {
  readonly bound: unknown;
  readonly description: Description;
  release: () => void;
}

/**
 * Translates the JSON a vector writes into the values the bound object takes, and what it answers back into JSON, by
 * the kinds the description gives each one; a name the description does not give is handed on as written, for the
 * bound object to refuse.
 */
class Translation {
  /** The names the definitions this translation kept were kept under. */
  readonly keptDefinitions: string[] = [];

  constructor(
    readonly description: Description,
    readonly kept: Map<string, DescribedHandle>,
    readonly definitions: Map<string, KeptDefinition>,
  ) {}

  input(kind: number, element: number, type: string | null, json: Json | undefined): unknown {
    if (json === undefined) {
      return undefined;
    }
    if (integerKinds.includes(kind)) {
      return BigInt(json as string);
    }
    switch (kind) {
      case DescribedKind.Bytes:
        return Uint8Array.from(json as number[]);
      case DescribedKind.Struct:
        return this.structInput(type, json as Record<string, Json>);
      case DescribedKind.Pointer:
        return this.input(element, DescribedKind.None, type, json);
      case DescribedKind.Array:
        return (json as Json[]).map((item) => this.input(element, DescribedKind.None, type, item));
      case DescribedKind.Handle:
        return this.#kept((json as { handle: string }).handle);
      default:
        return json;
    }
  }

  structInput(type: string | null, json: Record<string, Json>): Record<string, unknown> {
    const described = typeOf(this.description, type);
    return Object.fromEntries(
      Object.entries(json).map(([name, value]) => {
        const member = described.members.find((candidate) => candidate.name === name);
        return [name, member === undefined ? value : this.input(member.kind, member.element, member.type, value)];
      }),
    );
  }

  answer(kind: number, element: number, type: string | null, value: unknown, keep: string | undefined): Json | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (integerKinds.includes(kind)) {
      return String(value);
    }
    switch (kind) {
      case DescribedKind.Bytes:
        return [...(value as Uint8Array)];
      case DescribedKind.Struct:
        return this.structAnswer(type, value as Record<string, unknown>, keep);
      case DescribedKind.Pointer:
        return this.answer(element, DescribedKind.None, type, value, keep);
      case DescribedKind.Array:
        return (value as unknown[]).map((item) => this.answer(element, DescribedKind.None, type, item, keep)!);
      case DescribedKind.Handle:
        return this.#keep(value as DescribedHandle, keep);
      case DescribedKind.Definition:
        return this.#keepDefinition(value, type, keep);
      default:
        return value as Json;
    }
  }

  structAnswer(type: string | null, value: Record<string, unknown>, keep: string | undefined): Record<string, Json> {
    const described = typeOf(this.description, type);
    return Object.fromEntries(
      Object.entries(value).map(([name, member]) => {
        const describedMember = described.members.find((candidate) => candidate.name === name)!;
        return [name, this.answer(describedMember.kind, describedMember.element, describedMember.type, member, keep)!];
      }),
    );
  }

  #kept(name: string): DescribedHandle {
    const handle = this.kept.get(name);
    if (handle === undefined) {
      throw new Error(`The vector hands the handle ${name}, which no earlier step kept.`);
    }
    return handle;
  }

  #keepDefinition(bound: unknown, type: string | null, keep: string | undefined): Json {
    if (keep === undefined) {
      throw new Error("An operation answered a definition, and its step names no keep.");
    }
    const description = this.description.definitions.find((nested) => nested.definition === type);
    if (description === undefined) {
      throw new Error(`The description of ${this.description.definition} nests no description of ${type}.`);
    }
    this.definitions.set(keep, { bound, description, release: () => {} });
    this.keptDefinitions.push(keep);
    return { definition: keep };
  }

  #keep(handle: DescribedHandle, keep: string | undefined): Json {
    if (keep === undefined) {
      throw new Error("An operation answered a handle, and its step names no keep.");
    }
    this.kept.set(keep, handle);
    return { handle: keep };
  }
}

/** Whether a bound object refused a call as its caller's mistake, before calling anything. */
function isCallersMistake(error: unknown): boolean {
  return error instanceof TypeError || error instanceof EmbeddedNulError || error instanceof OperationNotOfferedError;
}

type ReleaseCounts = Record<string, string>;

/** A count's C field name as the vector spells it, `nested_refusals` as `nestedRefusals`. */
function camelCaseOf(name: string): string {
  return name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

class DescriptionRun {
  readonly got: boolean[] = [];
  readonly calls: Record<string, Json>[] = [];
  readonly releases: ReleaseCounts[] = [];
  readonly blocking: string[][] = [];
  loaded = false;
  callersMistake = false;
  readonly #declaration: LibraryDeclaration;
  readonly #contexts = new Map<string, PluginContext>();
  readonly #resolved = new Map<string, unknown>();
  readonly #addresses = new Map<string, bigint>();
  readonly #descriptions = new Map<string, Description>();
  readonly #served: [string, unknown][] = [];
  readonly #kept = new Map<string, DescribedHandle>();
  readonly #keptDefinitions = new Map<string, KeptDefinition>();
  #library: LoadedLibrary | undefined;
  #reportedFrom: { logs: number; sunk: number } | undefined;

  constructor(
    readonly world: DriverWorld,
    readonly describedLibraryPath: string,
    readonly given: DescriptionGiven,
  ) {
    this.#declaration = declarationOf(given.declaration);
    world.register(given.holders.map((holder) => this.#holder(holder)));
    for (const holder of given.holders) {
      this.#contexts.set(holder, world.open(holder));
    }
  }

  #holder(holder: string): BuiltPlugin {
    return {
      manifest: {
        importName: holder,
        api: 1,
        entry: `${holder}.ts`,
        services: { consumes: this.#declaration.services.map((service) => ({ id: service.id })) },
        capabilities: { provides: [neverProvided], consumes: [] },
      },
      entry: inertEntry,
    };
  }

  async runAll(steps: readonly Step[]): Promise<void> {
    this.#reportedFrom = { logs: this.world.logs.length, sunk: this.world.sunk.length };
    for (const step of steps) {
      await this.#perform(step);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  async #perform(step: Step): Promise<void> {
    if ("load" in step) {
      this.#load();
    } else if ("get" in step) {
      this.#get(step.holder, step.get);
    } else if ("call" in step) {
      this.calls.push(await this.#call(step.holder, step.call, step.operation, step.with ?? {}, step.keep));
    } else if ("release" in step) {
      this.#release(step.release);
    } else if ("blocking" in step) {
      this.blocking.push(this.#blockingOf(step.holder, step.blocking));
    } else if ("readReleases" in step) {
      this.releases.push(await this.#readReleases(step.holder));
    } else {
      this.#library?.unload();
    }
  }

  #load(): void {
    try {
      this.#library = alive(this.world.host.loadLibrary(this.#declaration, this.describedLibraryPath));
      this.loaded = true;
    } catch (error) {
      this.callersMistake = !(error instanceof RefusalError || error instanceof OutOfMemoryError);
      return;
    }
    this.#readBinary();
  }

  /**
   * Reads each definition's address and each description by calling their symbols on a handle of the suite's own,
   * opened while the layer holds the binary and closed again before the next step; a description is copied whole.
   */
  #readBinary(): void {
    const binary = koffi.load(this.describedLibraryPath);
    try {
      for (const service of this.#declaration.services) {
        const answered = (binary.func(service.functions[0]!.symbol, "void *", []) as () => object | null)();
        this.#addresses.set(service.id, answered === null ? 0n : koffi.address(answered));
        if (service.description !== undefined) {
          this.#descriptions.set(service.id, readDescription((binary.func(service.description, "void *", []) as () => object)()));
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
      this.#served.push([id, object]);
    }
  }

  /** The bound object and description a step names by `id`: a service the holder resolved, or a definition kept under that name. */
  #callable(holder: string, id: string): { bound: unknown; description: Description } | undefined {
    const kept = this.#keptDefinitions.get(id);
    if (kept !== undefined) {
      return kept;
    }
    const description = this.#descriptions.get(id);
    const bound = this.#resolved.get(`${holder} ${id}`);
    return description === undefined || bound === undefined ? undefined : { bound, description };
  }

  #blockingOf(holder: string, id: string): string[] {
    const callable = this.#callable(holder, id);
    const blocking = callable === undefined ? undefined : blockingOperationsOf(callable.bound);
    if (blocking === undefined) {
      throw new Error(`${holder} holds no bound ${id} to read its blocking operations from.`);
    }
    return [...blocking];
  }

  async #call(holder: string, id: string, operation: string, input: Record<string, unknown>, keep: string | undefined): Promise<Record<string, Json>> {
    const callable = this.#callable(holder, id);
    if (callable === undefined) {
      throw new Error(`${holder} holds no described ${id} to call ${operation} on.`);
    }
    const { description } = callable;
    const bound = callable.bound as Record<string, (input: unknown) => Promise<unknown>>;
    const described = description.operations.find((candidate) => candidate.name === operation)!;
    const translation = new Translation(description, this.#kept, this.#keptDefinitions);
    const arguments_ = Object.fromEntries(
      Object.entries(input).map(([name, json]) => {
        const parameter = described.parameters.find((candidate) => candidate.name === name);
        return [name, parameter === undefined ? json : translation.input(parameter.kind, parameter.element, parameter.type, json as Json)];
      }),
    );
    try {
      const answered = await bound[operation]!(arguments_);
      if (answered === none) {
        return { status: "none" };
      }
      const answerParameter = described.parameters.find((parameter) => parameter.role === DescribedRole.Answer)!;
      const answer = translation.answer(answerParameter.kind, answerParameter.element, answerParameter.type, answered, keep);
      for (const name of translation.keptDefinitions) {
        this.#keptDefinitions.get(name)!.release = () => (answered as { release(): void }).release();
      }
      return answer === undefined ? { status: "ok" } : { status: "ok", answer };
    } catch (error) {
      if (isCallersMistake(error)) {
        return { callersMistake: true };
      }
      if (!(error instanceof DescribedCallError)) {
        throw error;
      }
      const status = statusNames[error.status] ?? String(error.status);
      return status === "refused" ? { status, detail: error.detail, fix: error.fix } : { status };
    }
  }

  async #readReleases(holder: string): Promise<ReleaseCounts> {
    const mirror = [...this.#resolved].find(([key, object]) => key.startsWith(`${holder} `) && typeof (object as Record<string, unknown>).count_releases === "function");
    if (mirror === undefined) {
      throw new Error(`${holder} holds no definition answering count_releases.`);
    }
    const counts = (await (mirror[1] as { count_releases: () => Promise<Record<string, number | bigint>> }).count_releases()) ?? {};
    return Object.fromEntries(Object.entries(counts).map(([kind, count]) => [camelCaseOf(kind), String(count)]));
  }

  /** Lets go of the handle kept under `name`, or ends the answer that carried the definition kept under it. */
  #release(name: string): void {
    const handle = this.#kept.get(name);
    const definition = this.#keptDefinitions.get(name);
    if (handle === undefined && definition === undefined) {
      throw new Error(`The vector releases ${name}, which no earlier step kept.`);
    }
    handle?.release();
    definition?.release();
  }

  #contextOf(holder: string): PluginContext {
    const context = this.#contexts.get(holder);
    if (context === undefined) {
      throw new Error(`A step names a holder the vector does not give: ${holder}.`);
    }
    return context;
  }

  #addressOf(object: unknown): bigint | undefined {
    const bound = boundDefinitionOf(object);
    if (bound !== undefined) {
      return koffi.address(bound.pointer);
    }
    const opaque = object as { pointer?: object };
    return typeof opaque === "object" && opaque !== null && opaque.pointer !== undefined ? koffi.address(opaque.pointer) : undefined;
  }

  #released(): ReleaseCounts[] {
    const [first, ...later] = this.releases;
    return later.map((counts) => Object.fromEntries(Object.entries(counts).map(([kind, count]) => [kind, String(BigInt(count) - BigInt(first![kind]!))])));
  }

  observers(): Record<string, Observer> {
    return {
      loaded: () => this.loaded,
      callersMistake: () => this.callersMistake,
      got: () => [...this.got],
      sameObject: () => this.#served.length > 0 && this.#served.every(([id, object]) => this.#addressOf(object) === this.#addresses.get(id)),
      calls: () => [...this.calls],
      released: () => this.#released(),
      blocking: () => this.blocking.map((names) => [...names]),
      reported: () => [
        ...this.world.logs.slice(this.#reportedFrom?.logs ?? 0).map((entry) => `${entry.source} ${entry.level} ${entry.message}`),
        ...this.world.sunk.slice(this.#reportedFrom?.sunk ?? 0).map((error) => (error instanceof Error ? error.message : String(error))),
      ],
    };
  }
}

/**
 * Loads the vector's declaration through the host with the described library beside it, drives its steps in order,
 * and answers what the run shows.
 *
 * @throws Error when the driver was given no described library.
 */
export async function driveDescription(vector: LayerVector, world: DriverWorld, describedLibraryPath: string | undefined): Promise<Record<string, Observer>> {
  if (describedLibraryPath === undefined) {
    throw new Error(`The vector ${vector.id} loads the standard's described library, and the driver was given no describedLibraryPath.`);
  }
  const given = checkGiven(vector);
  const run = new DescriptionRun(world, describedLibraryPath, given);
  await run.runAll(given.steps);
  return run.observers();
}
