import koffi from "koffi";
import { LibraryUnloadedError, type LibraryDefinition } from "../libraries.js";
import type { HandleHoldings } from "./handles.js";
import { DescribedKind, DescribedReturn } from "./layout.js";
import { DescribedLayouts, DescriptionLayoutError, type LaidOutType } from "./layouts.js";
import { OperationCall, ReleaseCall, type OperationInput } from "./operations.js";
import type { Description } from "./reader.js";
import type { StructContext } from "./structs.js";

/**
 * A described definition as a plugin sees it: one async method per operation of the definition, named as the
 * operation, taking an object of its inputs by parameter name.
 */
export type BoundDefinition = Readonly<Record<string, (input?: OperationInput) => Promise<unknown>>>;

const boundAddresses = new WeakMap<object, LibraryDefinition>();

/** The library and the very struct a bound definition stands for, or undefined for any other object. */
export function boundDefinitionOf(object: unknown): LibraryDefinition | undefined {
  return typeof object === "object" && object !== null ? boundAddresses.get(object) : undefined;
}

export interface DefinitionToBind {
  readonly definition: LibraryDefinition;
  readonly description: Description;
  readonly holdings: HandleHoldings;
  /** Whether the binary is still open, so a call may reach it. */
  readonly isOpen: () => boolean;
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

/**
 * The `size` the definition's struct answered.
 *
 * @throws DescriptionLayoutError for a definition whose struct is smaller than the description's first shape.
 */
function answeredSizeOf(definition: LibraryDefinition, description: Description, layouts: DescribedLayouts): number {
  const answered = koffi.decode(definition.pointer, "uint32_t") as number;
  const firstShape = layouts.type(description.definition).described.firstShape;
  if (answered < firstShape) {
    throw new DescriptionLayoutError(description.definition, `its library answered a struct of size ${answered}, below its first shape of ${firstShape}`);
  }
  return answered;
}

/**
 * Builds a definition's bound object from its description: the koffi layout of every struct it names, checked against
 * the description, and one prototype per operation, each built once here and reused by every call.
 *
 * @throws DescriptionLayoutError, the caller's mistake, for a description whose layout this platform disagrees with
 * or that names what this binding cannot marshal.
 */
export function bindDefinition(bind: DefinitionToBind): BoundDefinition {
  const { definition, description, holdings } = bind;
  const layouts = new DescribedLayouts(description);
  const answeredSize = answeredSizeOf(definition, description, layouts);
  const context = contextOf(definition.pointer, answeredSize, layouts.type(description.definition));
  const releases = new Map(
    description.operations
      .filter((operation) => operation.returns === DescribedReturn.Nothing)
      .map((operation) => [operation.name, new ReleaseCall(functionAt(definition.pointer, operation.offset, answeredSize), context)] as const),
  );
  const structContext: StructContext = {
    layouts,
    holdings,
    freeHandle: (release, pointer) => {
      if (release !== null && bind.isOpen()) {
        releases.get(release)?.free(pointer);
      }
    },
  };
  const bound = Object.create(null) as Record<string, unknown>;
  for (const operation of description.operations.filter((candidate) => candidate.returns === DescribedReturn.Status)) {
    if (operation.name === "then") {
      throw new DescriptionLayoutError(description.definition, "its operation then would make the bound object a thenable, which every await would call");
    }
    const call = new OperationCall(
      description.definition,
      operation,
      layouts,
      functionAt(definition.pointer, operation.offset, answeredSize),
      context,
      releases,
    );
    const symbol = `${description.definition}.${operation.name}`;
    Object.defineProperty(bound, operation.name, {
      enumerable: true,
      value: async (input: OperationInput = {}) => {
        if (!bind.isOpen()) {
          throw new LibraryUnloadedError(symbol);
        }
        return call.invoke(input, structContext);
      },
    });
  }
  Object.freeze(bound);
  boundAddresses.set(bound, definition);
  return bound as BoundDefinition;
}
