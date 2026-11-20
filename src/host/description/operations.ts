import koffi from "koffi";
import { Status } from "../../core/constants.js";
import { CallArena } from "./arena.js";
import type { DescribedHandle } from "./handles.js";
import { DescribedKind, DescribedRole } from "./layout.js";
import type { DescribedLayouts, LaidOutType, ReachPlan } from "./layouts.js";
import { none, DescribedCallError, OperationNotOfferedError } from "./outcome.js";
import type { DescribedOperation, DescribedParameter } from "./reader.js";
import { isScalarKind, scalarForC, scalarTypes } from "./scalars.js";
import { littleEndian, refuseUnknownNames, scalarAt, StructWriter, type StructContext } from "./structs.js";
import { readValue, valueTreeRootOffset, valueTreeSize } from "./values.js";

type KoffiType = ReturnType<typeof koffi.opaque>;

const pointerSize = koffi.sizeof("void *");

/** A release of the definition: it takes the context and the one thing it frees, and returns nothing. */
export class ReleaseCall {
  readonly #proto: KoffiType;

  constructor(
    readonly functionPointer: object | null,
    readonly context: object | null,
  ) {
    this.#proto = koffi.proto("void", ["void *", "void *"]);
  }

  /** Frees `pointer`; a release the provider left NULL frees nothing. */
  free(pointer: object): void {
    if (this.functionPointer === null) {
      return;
    }
    koffi.call(this.functionPointer, this.#proto, this.context, pointer);
  }
}

/**
 * A block an operation hands its provider on every call, an answer or a refusal, allocated once at the bind and emptied
 * before each call, its leading size set.
 *
 * @implNote One block per operation is enough because a call runs to its end on the calling thread, the provider
 * calls back into nothing, and every answer is copied out and released in the call's `finally`.
 */
class FixedBlock {
  readonly block: object;
  readonly view: DataView;
  readonly #bytes: Uint8Array;

  constructor(
    readonly byteSize: number,
    readonly leadingSize: number | undefined,
  ) {
    this.block = koffi.alloc("uint8_t", byteSize) as object;
    const memory = koffi.view(this.block, byteSize);
    this.view = new DataView(memory);
    this.#bytes = new Uint8Array(memory);
  }

  empty(): void {
    this.#bytes.fill(0);
    if (this.leadingSize !== undefined) {
      this.view.setUint32(0, this.leadingSize, littleEndian);
    }
  }
}

const fixedBlocks = new FinalizationRegistry<readonly object[]>((blocks) => blocks.forEach((block) => koffi.free(block)));

/** An answer slot of an operation: what the provider writes into, and how it is read and freed. */
interface AnswerSlot {
  readonly parameter: DescribedParameter;
  readonly plan: ReachPlan;
  readonly fixed: FixedBlock;
  readonly type: LaidOutType | undefined;
}

/** The refusal of an operation, read for its `detail` and `fix` and freed by the release it names. */
interface RefusalSlot {
  readonly parameter: DescribedParameter;
  readonly fixed: FixedBlock;
  readonly type: LaidOutType;
}

/** What one parameter is handed, worked out at the bind. */
type ParameterStep =
  | { readonly role: "context" }
  | { readonly role: "answer"; readonly slot: AnswerSlot }
  | { readonly role: "refusal"; readonly slot: RefusalSlot }
  | { readonly role: "count"; readonly parameter: DescribedParameter }
  | { readonly role: "scalar"; readonly parameter: DescribedParameter }
  | { readonly role: "reached"; readonly parameter: DescribedParameter; readonly plan: ReachPlan; readonly countIndex: number };

/** What a caller of the bound object's method hands it: one value per input parameter, keyed by its name. */
export type OperationInput = Readonly<Record<string, unknown>>;

/**
 * One operation of a described definition, its prototype, its parameter steps and its answer and refusal blocks
 * built once at the bind, from a description the standard's check passed.
 */
export class OperationCall {
  readonly name: string;
  /** The parameters a caller writes: every input but the context and a size counting another parameter. */
  readonly inputNames: readonly string[];
  readonly #operation: DescribedOperation;
  readonly #proto: KoffiType;
  readonly #counted: ReadonlySet<string>;
  readonly #steps: readonly ParameterStep[];
  readonly #answers: readonly AnswerSlot[];
  readonly #refusal: RefusalSlot | undefined;
  #calling = false;

  /** @throws DescriptionLayoutError for a parameter reaching an element this binding cannot marshal. */
  constructor(
    readonly definition: string,
    operation: DescribedOperation,
    readonly layouts: DescribedLayouts,
    readonly functionPointer: object | null,
    readonly context: object | null,
    readonly releases: ReadonlyMap<string, ReleaseCall>,
  ) {
    this.name = operation.name;
    this.#operation = operation;
    this.#counted = new Set(operation.parameters.flatMap((parameter) => (parameter.count === null ? [] : [parameter.count])));
    operation.parameters.forEach((parameter) =>
      this.layouts.refuseUnreachableElement(parameter.kind, parameter.element, parameter.type, `its operation ${this.name}'s ${parameter.name}`),
    );
    this.inputNames = operation.parameters
      .filter((parameter) => parameter.role === DescribedRole.Input && parameter.kind !== DescribedKind.Context && !this.#counted.has(parameter.name))
      .map((parameter) => parameter.name);
    this.#steps = operation.parameters.map((parameter) => this.#stepOf(parameter));
    this.#answers = this.#steps.flatMap((step) => (step.role === "answer" ? [step.slot] : []));
    this.#refusal = this.#steps.find((step): step is Extract<ParameterStep, { role: "refusal" }> => step.role === "refusal")?.slot;
    fixedBlocks.register(this, [...this.#answers.map((slot) => slot.fixed.block), ...(this.#refusal === undefined ? [] : [this.#refusal.fixed.block])]);
    this.#proto = koffi.proto(
      "int",
      this.#steps.map((step) => (step.role === "scalar" || step.role === "count" ? scalarTypes[step.parameter.kind]! : step.role === "reached" ? this.layouts.inputCallType(step.plan) : "void *")),
    );
  }

  #stepOf(parameter: DescribedParameter): ParameterStep {
    if (parameter.kind === DescribedKind.Context) {
      return { role: "context" };
    }
    if (parameter.role === DescribedRole.Answer) {
      return { role: "answer", slot: this.#answerSlot(parameter) };
    }
    if (parameter.role === DescribedRole.Refusal) {
      const type = this.layouts.type(parameter.type);
      return { role: "refusal", slot: { parameter, type, fixed: new FixedBlock(type.described.size, sizeOf(type)) } };
    }
    if (this.#counted.has(parameter.name)) {
      return { role: "count", parameter };
    }
    if (isScalarKind(parameter.kind)) {
      return { role: "scalar", parameter };
    }
    const countIndex = parameter.count === null ? -1 : this.#operation.parameters.findIndex((candidate) => candidate.name === parameter.count);
    return { role: "reached", parameter, plan: this.layouts.planOf(parameter), countIndex };
  }

  #answerSlot(parameter: DescribedParameter): AnswerSlot {
    const plan = this.layouts.planOf(parameter);
    if (parameter.kind === DescribedKind.Pointer) {
      const type = this.layouts.type(parameter.type);
      return { parameter, plan, type, fixed: new FixedBlock(type.described.size, sizeOf(type)) };
    }
    if (parameter.kind === DescribedKind.Value) {
      return { parameter, plan, type: undefined, fixed: new FixedBlock(valueTreeSize, valueTreeSize) };
    }
    return { parameter, plan, type: undefined, fixed: new FixedBlock(Math.max(pointerSize, 8), undefined) };
  }

  /**
   * Calls the operation with `input`, every answer copied out and released before it settles.
   *
   * @returns the answer on OK, `none` on NONE.
   * @throws DescribedCallError for any other status; TypeError for an input its parameter does not hold, a name it
   * does not take or structs nested deeper than the standard's limit, and OperationNotOfferedError for an operation
   * the provider does not offer, each the caller's mistake, refused before anything is called.
   */
  invoke(input: OperationInput, context: StructContext): unknown {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new TypeError(`${this.name} takes its inputs as one object, keyed by parameter name.`);
    }
    if (this.functionPointer === null) {
      throw new OperationNotOfferedError(this.definition, this.name);
    }
    refuseUnknownNames(input, this.inputNames, `${this.name}'s input`);
    if (this.#calling) {
      throw new Error(`${this.name} was called while a call of it was still running, which its answer blocks cannot hold.`);
    }
    this.#calling = true;
    const arena = new CallArena();
    try {
      const writer = new StructWriter(context, arena);
      const parameters = this.#prepare(writer, input);
      const status = koffi.call(this.functionPointer, this.#proto, ...parameters) as number;
      return this.#outcome(writer, status);
    } finally {
      arena.free();
      this.#calling = false;
    }
  }

  #prepare(writer: StructWriter, input: OperationInput): unknown[] {
    const parameters = new Array<unknown>(this.#steps.length);
    this.#answers.forEach((slot) => slot.fixed.empty());
    this.#refusal?.fixed.empty();
    this.#steps.forEach((step, index) => {
      switch (step.role) {
        case "context":
          parameters[index] = this.context;
          return;
        case "answer":
        case "refusal":
          parameters[index] = step.slot.fixed.block;
          return;
        case "count":
          parameters[index] ??= 0;
          return;
        case "scalar":
          parameters[index] = scalarForC(step.parameter.kind, input[step.parameter.name], `${this.name}'s ${step.parameter.name}`);
          return;
        case "reached": {
          const written = writer.written(step.plan, input[step.parameter.name], `${this.name}'s ${step.parameter.name}`, true);
          parameters[index] = written.value;
          if (step.countIndex >= 0) {
            parameters[step.countIndex] = written.count;
          }
        }
      }
    });
    return parameters;
  }

  #outcome(writer: StructWriter, status: number): unknown {
    const handles: DescribedHandle[] = [];
    try {
      if (status === Status.Ok) {
        return this.#answer(this.#answers.map((slot) => [slot.parameter.name, this.#readAnswer(writer, slot, handles)] as const));
      }
      if (status === Status.None) {
        return none;
      }
      throw this.#failure(status, this.#refusal);
    } catch (error) {
      handles.forEach((handle) => handle.release());
      throw error;
    } finally {
      this.#answers.forEach((slot) => this.#releaseAnswer(slot));
      if (this.#refusal?.parameter.release != null) {
        this.releases.get(this.#refusal.parameter.release)!.free(this.#refusal.fixed.block);
      }
    }
  }

  #answer(answers: readonly (readonly [string, unknown])[]): unknown {
    if (answers.length === 1) {
      return answers[0]![1];
    }
    if (answers.length === 0) {
      return undefined;
    }
    return Object.fromEntries(answers);
  }

  #readAnswer(writer: StructWriter, slot: AnswerSlot, handles: DescribedHandle[]): unknown {
    const { parameter, fixed } = slot;
    if (slot.type !== undefined) {
      return writer.readStruct(fixed.block, fixed.view, 0, slot.type, handles);
    }
    if (parameter.kind === DescribedKind.Value) {
      return readValue(fixed.block, valueTreeRootOffset);
    }
    if (isScalarKind(parameter.kind)) {
      return scalarAt(fixed.view, 0, parameter.kind);
    }
    return writer.readReached(slot.plan, fixed.block, 0, isNullPointer(fixed.view), 0, handles) ?? null;
  }

  /** A struct or tree answer is freed through what was handed in; the check lets no scalar or text answer name a release. */
  #releaseAnswer(slot: AnswerSlot): void {
    const { parameter } = slot;
    if (parameter.release !== null && parameter.kind !== DescribedKind.Handle) {
      this.releases.get(parameter.release)!.free(slot.fixed.block);
    }
  }

  #failure(status: number, refusal: RefusalSlot | undefined): DescribedCallError {
    if (status !== Status.Refused || refusal === undefined) {
      return new DescribedCallError(this.name, status, null, null);
    }
    const text = (name: string): string | null => koffi.decode(refusal.fixed.block, refusal.type.members.get(name)!.offset, "const char *") as string | null;
    return new DescribedCallError(this.name, status, text("detail"), text("fix"));
  }
}

function sizeOf(type: LaidOutType): number | undefined {
  return type.leadingSize ? type.described.size : undefined;
}

function isNullPointer(view: DataView): boolean {
  return pointerSize === 8 ? view.getBigUint64(0, littleEndian) === 0n : view.getUint32(0, littleEndian) === 0;
}
