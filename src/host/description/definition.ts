import koffi from "koffi";
import { rememberDescribedEnums, type DescribedEnums } from "../../context/described-enums.js";
import { LibraryUnloadedError, type LibraryDefinition } from "../libraries.js";
import { enumsByName } from "./enums.js";
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
  /** Whether the binary is still mapped, so a provider's release may run; `isOpen` when absent. */
  readonly canRelease?: () => boolean;
  /** Counts the calls running on the worker thread; nothing counts them when absent. */
  readonly calls?: CallTracking;
}

/** What one bound definition shares with what it was got from: a library, or the answer that carried it. */
interface BindingEnvironment {
  /** The import name of the library, or undefined for a definition a host bound itself. */
  readonly library: string | undefined;
  /** Where every answer and handle got through the definition is held until it is released. */
  readonly holdings: HandleHoldings;
  readonly isOpen: () => boolean;
  readonly canRelease: () => boolean;
  readonly calls: CallTracking;
}

/**
 * What a definition an answer carried lives in, with everything got through it: its worker calls counted, each one
 * counted in what it was got from too, and its answers and handles held, so the carrying answer is released only
 * once all of that has ended.
 */
class CarriedScope implements CallTracking {
  readonly holdings: HandleHoldings;
  live = true;
  #running = 0;
  #whenIdle: (() => void) | undefined;

  constructor(
    readonly parent: CallTracking,
    parentHoldings: HandleHoldings,
  ) {
    this.holdings = parentHoldings.child();
  }

  begin(): void {
    this.#running += 1;
    this.parent.begin();
  }

  end(): void {
    this.#running -= 1;
    try {
      if (this.#running === 0 && this.#whenIdle !== undefined) {
        const idle = this.#whenIdle;
        this.#whenIdle = undefined;
        idle();
      }
    } finally {
      this.parent.end();
    }
  }

  /**
   * Refuses every new call at once; once every running call has returned, releases what was got through the
   * definition, then calls `then`.
   */
  close(then: () => void): void {
    this.live = false;
    const finish = (): void => {
      this.holdings.releaseAll();
      then();
    };
    if (this.#running === 0) {
      finish();
    } else {
      this.#whenIdle = finish;
    }
  }
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
 * @implNote A definition an answer carries reuses the description's layouts and prototypes, and has its functions,
 * context and releases read afresh from its struct on every answer, since a provider may free a definition it lent
 * and lend another at the same address.
 */
class DescribedBinding {
  readonly layouts: DescribedLayouts;
  readonly blocking: readonly string[];
  readonly enums: DescribedEnums;
  readonly #description: Description;
  readonly #calls: readonly OperationCall[];
  readonly #nested: ReadonlyMap<string, DescribedBinding>;

  /** @throws DescriptionLayoutError for a description whose layout this platform disagrees with, or that names what this binding cannot marshal. */
  constructor(description: Description) {
    this.#description = description;
    this.layouts = new DescribedLayouts(description);
    this.enums = enumsByName(description.enums);
    this.#nested = new Map(description.definitions.map((nested) => [nested.definition, new DescribedBinding(nested)] as const));
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
  #targetsOf(pointer: object, environment: BindingEnvironment): ReadonlyMap<string, OperationTarget> {
    const answeredSize = this.#answeredSizeOf(pointer);
    const context = contextOf(pointer, answeredSize, this.layouts.type(this.#description.definition));
    const releases = new Map(
      this.#description.operations
        .filter((operation) => operation.returns === DescribedReturn.Nothing)
        .map((operation) => [operation.name, new ReleaseCall(functionAt(pointer, operation.offset, answeredSize), context)] as const),
    );
    const { holdings, isOpen, canRelease, calls } = environment;
    const structs: StructContext = {
      layouts: this.layouts,
      holdings,
      freeHandle: (release, held) => {
        if (release !== null && canRelease()) {
          releases.get(release)?.free(held);
        }
      },
      bindCarried: (type, carried) => this.#nestedBinding(type).bindCarried(carried, environment),
    };
    const offsets = new Map(this.#description.operations.map((operation) => [operation.name, operation.offset] as const));
    return new Map(
      this.#calls.map((call) => [
        call.name,
        { symbol: `${this.#description.definition}.${call.name}`, functionPointer: functionAt(pointer, offsets.get(call.name)!, answeredSize), context, releases, structs, calls, isOpen, canRelease },
      ] as const),
    );
  }

  /** A bound object of one async method per operation, each refused once `refusal` answers an error. */
  #boundObject(pointer: object, targets: ReadonlyMap<string, OperationTarget>, library: string | undefined, refusal: (symbol: string) => Error | undefined): Record<string, unknown> {
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
    rememberDescribedEnums(bound, this.enums);
    if (library !== undefined) {
      boundAddresses.set(bound, Object.freeze({ library, pointer }));
    }
    return bound;
  }

  /** The definition struct at `pointer` as its frozen bound object. */
  bind(pointer: object, environment: BindingEnvironment): BoundDefinition {
    const refusal = (symbol: string): Error | undefined => (environment.isOpen() ? undefined : new LibraryUnloadedError(symbol));
    return Object.freeze(this.#boundObject(pointer, this.#targetsOf(pointer, environment), environment.library, refusal)) as BoundDefinition;
  }

  /**
   * The definition struct at `pointer`, which an answer got through `parent` carried, as a bound object living, with
   * everything got through it, until `end`; the answer freezes it once it has been given its own `release()`.
   */
  bindCarried(pointer: object, parent: BindingEnvironment): CarriedDefinition {
    const scope = new CarriedScope(parent.calls, parent.holdings);
    const environment: BindingEnvironment = { ...parent, holdings: scope.holdings, calls: scope };
    const definition = this.#description.definition;
    const refusal = (symbol: string): Error | undefined => {
      if (!scope.live) {
        return new TypeError(`${definition} was carried by an answer that has been released, and lives only as long as that answer.`);
      }
      return parent.isOpen() ? undefined : new LibraryUnloadedError(symbol);
    };
    return {
      bound: this.#boundObject(pointer, this.#targetsOf(pointer, environment), parent.library, refusal),
      end: (then) => scope.close(then),
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
    canRelease: bind.canRelease ?? bind.isOpen,
    calls: bind.calls ?? noTracking,
  };
  return new DescribedBinding(bind.description).bind(bind.definition.pointer, environment);
}

/**
 * Binds a definition a host got some other way than from a library's service, as the binding binds one a library
 * serves: one async method per operation, a blocking one run on koffi's worker thread.
 *
 * No library stands behind the object, so nothing is released for its caller: every handle it answers, and every
 * answer carrying a definition, lives until the caller calls its `release()`.
 *
 * @param pointer the definition's struct, which must outlive the bound object.
 * @param description a `const weivel_standard_description *` that weivel_standard_description_check has passed; it is
 * read once here and never checked again.
 * @throws DescriptionLayoutError, the caller's mistake, for a description this platform or this binding cannot bind.
 */
export function bindDefinition(pointer: object, description: object): BoundDefinition {
  const environment: BindingEnvironment = {
    library: undefined,
    holdings: new HandleHoldings(),
    isOpen: () => true,
    canRelease: () => true,
    calls: noTracking,
  };
  return new DescribedBinding(readDescription(description)).bind(pointer, environment);
}
