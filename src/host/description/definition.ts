import koffi from "koffi";
import { LibraryUnloadedError, type LibraryDefinition } from "../libraries.js";
import { HandleHoldings } from "./handles.js";
import { DescribedKind, DescribedReturn } from "./layout.js";
import { DescribedLayouts, DescriptionLayoutError, type LaidOutType } from "./layouts.js";
import { OperationCall, ReleaseCall, type CallTracking, type OperationInput, type OperationTarget } from "./operations.js";
import { readDescription, type Description } from "./reader.js";
import type { CarriedDefinition, StructContext } from "./structs.js";

/**
 * A described definition as a plugin sees it: one async method per operation of the definition, named as the
 * operation, taking an object of its inputs by parameter name.
 */
export type BoundDefinition = Readonly<Record<string, (input?: OperationInput) => Promise<unknown>>>;

const boundAddresses = new WeakMap<object, LibraryDefinition>();
const blockingNames = new WeakMap<object, readonly string[]>();

/** The library and the very struct a bound definition stands for, or undefined for any other object. */
export function boundDefinitionOf(object: unknown): LibraryDefinition | undefined {
  return typeof object === "object" && object !== null ? boundAddresses.get(object) : undefined;
}

/**
 * The operations of a bound definition that its description marks blocking, in the order the description lists its
 * operations, each of which runs on koffi's worker thread; undefined for anything but a bound definition.
 */
export function blockingOperationsOf(object: unknown): readonly string[] | undefined {
  return typeof object === "object" && object !== null ? blockingNames.get(object) : undefined;
}

const noTracking: CallTracking = { begin() {}, end() {} };

export interface DefinitionToBind {
  readonly definition: LibraryDefinition;
  readonly description: Description;
  readonly holdings: HandleHoldings;
  /** Whether the binary is still open, so a call may reach it. */
  readonly isOpen: () => boolean;
  /** Counts the calls running on the worker thread; nothing counts them when absent. */
  readonly calls?: CallTracking;
}

/** What every definition one description binds shares with the library it came from. */
interface BindingEnvironment {
  /** The import name of the library, or undefined for a definition a host bound itself. */
  readonly library: string | undefined;
  readonly holdings: HandleHoldings;
  readonly isOpen: () => boolean;
  readonly calls: CallTracking;
}

const pointerSize = koffi.sizeof("void *");

/** The context the definition's struct holds, read only inside the `answeredSize` bytes its library answered; null for none. */
export function contextOf(pointer: object, answeredSize: number, definition: LaidOutType): object | null {
  const member = definition.described.members.find((candidate) => candidate.kind === DescribedKind.Context);
  return member === undefined || member.offset + pointerSize > answeredSize ? null : (koffi.decode(pointer, member.offset, "void *") as object | null);
}

/**
 * The operation at `offset`, or null when the provider does not offer it: the struct it answered ends before it, as
 * WEIVEL_STANDARD_OFFERS reads an operation past `size`, or holds NULL there.
 */
function functionAt(pointer: object, offset: number, answeredSize: number): object | null {
  return offset + pointerSize > answeredSize ? null : (koffi.decode(pointer, offset, "void *") as object | null);
}

/** A member named `release` would hide the `release()` an answer carrying a definition is given. */
const answerRelease = "release";

/**
 * One description, bound: its layouts, one call per operation and the bindings of the definitions it nests, built
 * once, and every definition struct it describes bound through them.
 *
 * @implNote A definition an answer carries is bound once per address and handed out afresh per answer, so a provider
 * that lends the same definition on every call costs no prototype or layout after the first, and each answer's copy
 * still ends with that answer.
 */
class DescribedBinding {
  readonly layouts: DescribedLayouts;
  readonly blocking: readonly string[];
  readonly #description: Description;
  readonly #environment: BindingEnvironment;
  readonly #calls: readonly OperationCall[];
  readonly #nested: ReadonlyMap<string, DescribedBinding>;
  readonly #carriedTargets = new Map<bigint, ReadonlyMap<string, OperationTarget>>();

  /**
   * @throws DescriptionLayoutError for a description whose layout this platform disagrees with, that names what this
   * binding cannot marshal, or that nests a definition it does not describe.
   */
  constructor(description: Description, environment: BindingEnvironment) {
    this.#description = description;
    this.#environment = environment;
    this.layouts = new DescribedLayouts(description);
    this.#nested = new Map(description.definitions.map((nested) => [nested.definition, new DescribedBinding(nested, environment)] as const));
    const blocking = new Set(description.blocking);
    const statusOperations = description.operations.filter((operation) => operation.returns === DescribedReturn.Status);
    this.#calls = statusOperations.map((operation) => {
      if (operation.name === "then") {
        throw this.#refuse("its operation then would make the bound object a thenable, which every await would call");
      }
      return new OperationCall(description.definition, operation, this.layouts, { blocking: blocking.has(operation.name) });
    });
    this.blocking = Object.freeze(this.#calls.filter((call) => call.blocking).map((call) => call.name));
    this.#calls.filter((call) => call.keepsAnswers).forEach((call) => this.#refuseHiddenRelease(call));
    this.#refuseUndescribedDefinitions();
  }

  get operationNames(): readonly string[] {
    return this.#calls.map((call) => call.name);
  }

  #refuse(detail: string): DescriptionLayoutError {
    return new DescriptionLayoutError(this.#description.definition, detail);
  }

  #nestedBinding(name: string | null): DescribedBinding {
    const nested = name === null ? undefined : this.#nested.get(name);
    if (nested === undefined) {
      throw this.#refuse(`it names ${name} as a definition and nests no description of it`);
    }
    return nested;
  }

  #refuseUndescribedDefinitions(): void {
    for (const type of this.#description.types) {
      type.members.filter((member) => member.kind === DescribedKind.Definition).forEach((member) => this.#nestedBinding(member.type));
    }
    for (const operation of this.#description.operations) {
      operation.parameters.filter((parameter) => parameter.kind === DescribedKind.Definition).forEach((parameter) => this.#nestedBinding(parameter.type));
    }
  }

  /** The names an answer of `call` is read with at its top, where its own `release()` is given it. */
  #answerNames(call: OperationCall): readonly string[] {
    const [only, ...others] = call.answerParameters;
    if (only === undefined || others.length > 0) {
      return call.answerParameters.map((parameter) => parameter.name);
    }
    if (only.kind === DescribedKind.Definition) {
      return this.#nestedBinding(only.type).operationNames;
    }
    return only.kind === DescribedKind.Pointer ? this.layouts.type(only.type).visible.map((member) => member.name) : [];
  }

  #refuseHiddenRelease(call: OperationCall): void {
    if (this.#answerNames(call).includes(answerRelease)) {
      throw this.#refuse(`its operation ${call.name} answers a definition in an answer holding ${answerRelease}, which would hide the answer's own release`);
    }
  }

  /**
   * The `size` the definition's struct answered.
   *
   * @throws DescriptionLayoutError for a definition whose struct is smaller than the description's first shape.
   */
  #answeredSizeOf(pointer: object): number {
    const answered = koffi.decode(pointer, "uint32_t") as number;
    const firstShape = this.layouts.type(this.#description.definition).described.firstShape;
    if (answered < firstShape) {
      throw this.#refuse(`its library answered a struct of size ${answered}, below its first shape of ${firstShape}`);
    }
    return answered;
  }

  /** Every operation's target for the definition struct at `pointer`: its functions, its context and its releases. */
  #targetsOf(pointer: object): ReadonlyMap<string, OperationTarget> {
    const answeredSize = this.#answeredSizeOf(pointer);
    const context = contextOf(pointer, answeredSize, this.layouts.type(this.#description.definition));
    const releases = new Map(
      this.#description.operations
        .filter((operation) => operation.returns === DescribedReturn.Nothing)
        .map((operation) => [operation.name, new ReleaseCall(functionAt(pointer, operation.offset, answeredSize), context)] as const),
    );
    const { holdings, isOpen, calls } = this.#environment;
    const structs: StructContext = {
      layouts: this.layouts,
      holdings,
      freeHandle: (release, held) => {
        if (release !== null && isOpen()) {
          releases.get(release)?.free(held);
        }
      },
      bindCarried: (type, carried) => this.#nestedBinding(type).bindCarried(carried),
    };
    const offsets = new Map(this.#description.operations.map((operation) => [operation.name, operation.offset] as const));
    return new Map(
      this.#calls.map((call) => [
        call.name,
        { symbol: `${this.#description.definition}.${call.name}`, functionPointer: functionAt(pointer, offsets.get(call.name)!, answeredSize), context, releases, structs, calls, isOpen },
      ] as const),
    );
  }

  /** A bound object of one async method per operation, each refused once `refusal` answers an error. */
  #boundObject(pointer: object, targets: ReadonlyMap<string, OperationTarget>, refusal: (symbol: string) => Error | undefined): Record<string, unknown> {
    const bound = Object.create(null) as Record<string, unknown>;
    for (const call of this.#calls) {
      const target = targets.get(call.name)!;
      Object.defineProperty(bound, call.name, {
        enumerable: true,
        value: async (input: OperationInput = {}) => {
          const refused = refusal(target.symbol);
          if (refused !== undefined) {
            throw refused;
          }
          return call.invoke(input, target);
        },
      });
    }
    blockingNames.set(bound, this.blocking);
    if (this.#environment.library !== undefined) {
      boundAddresses.set(bound, Object.freeze({ library: this.#environment.library, pointer }));
    }
    return bound;
  }

  #unloadedRefusal(symbol: string): Error | undefined {
    return this.#environment.isOpen() ? undefined : new LibraryUnloadedError(symbol);
  }

  /** The definition struct at `pointer` as its frozen bound object. */
  bind(pointer: object): BoundDefinition {
    const bound = this.#boundObject(pointer, this.#targetsOf(pointer), (symbol) => this.#unloadedRefusal(symbol));
    return Object.freeze(bound) as BoundDefinition;
  }

  /**
   * The definition struct at `pointer`, which an answer carried, as a bound object living until `end` is called; the
   * answer freezes it once it has been given its own `release()`.
   */
  bindCarried(pointer: object): CarriedDefinition {
    const address = koffi.address(pointer);
    let targets = this.#carriedTargets.get(address);
    if (targets === undefined) {
      targets = this.#targetsOf(pointer);
      this.#carriedTargets.set(address, targets);
    }
    let live = true;
    const definition = this.#description.definition;
    const bound = this.#boundObject(pointer, targets, (symbol) =>
      live ? this.#unloadedRefusal(symbol) : new TypeError(`${definition} was carried by an answer that has been released, and lives only as long as that answer.`),
    );
    return {
      bound,
      end: () => {
        live = false;
      },
    };
  }
}

/**
 * Builds a library definition's bound object from its description: the koffi layout of every struct it names, checked
 * against the description, and one prototype per operation, each built once here and reused by every call.
 *
 * @throws DescriptionLayoutError, the caller's mistake, for a description whose layout this platform disagrees with
 * or that names what this binding cannot marshal.
 */
export function bindDescribed(bind: DefinitionToBind): BoundDefinition {
  const environment: BindingEnvironment = {
    library: bind.definition.library,
    holdings: bind.holdings,
    isOpen: bind.isOpen,
    calls: bind.calls ?? noTracking,
  };
  return new DescribedBinding(bind.description, environment).bind(bind.definition.pointer);
}

/**
 * Binds a definition a host got some other way than from a library's service, as the binding binds one a library
 * serves: one async method per operation, a blocking one run on koffi's worker thread.
 *
 * @param pointer the definition's struct, which must outlive the bound object.
 * @param description a `const weivel_standard_description *` that weivel_standard_description_check has passed; it is
 * read once here and never checked again.
 * @throws DescriptionLayoutError, the caller's mistake, for a description this platform or this binding cannot bind.
 */
export function bindDefinition(pointer: object, description: object): BoundDefinition {
  const environment: BindingEnvironment = { library: undefined, holdings: new HandleHoldings(), isOpen: () => true, calls: noTracking };
  return new DescribedBinding(readDescription(description), environment).bind(pointer);
}
