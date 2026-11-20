import koffi from "koffi";
import { Status } from "../../core/constants.js";
import { CallArena } from "./arena.js";
import type { DescribedHandle } from "./handles.js";
import { DescribedKind, DescribedRole } from "./layout.js";
import { DescriptionLayoutError, type DescribedLayouts, type LaidOutType } from "./layouts.js";
import { none, DescribedCallError } from "./outcome.js";
import type { DescribedOperation, DescribedParameter } from "./reader.js";
import { isScalarKind, scalarForC, scalarFromC, scalarTypes } from "./scalars.js";
import { refuseUnknownNames, StructWriter, type StructContext } from "./structs.js";
import { readValue, valueTreeRootOffset, valueTreeSize } from "./values.js";

type KoffiType = ReturnType<typeof koffi.opaque>;

const inputKinds: readonly number[] = [
  DescribedKind.Context,
  DescribedKind.U32,
  DescribedKind.U64,
  DescribedKind.I64,
  DescribedKind.F64,
  DescribedKind.Size,
  DescribedKind.Text,
  DescribedKind.Texts,
  DescribedKind.Bytes,
  DescribedKind.Pointer,
  DescribedKind.Array,
  DescribedKind.Handle,
];
const answerKinds: readonly number[] = [
  DescribedKind.U32,
  DescribedKind.U64,
  DescribedKind.I64,
  DescribedKind.F64,
  DescribedKind.Size,
  DescribedKind.Text,
  DescribedKind.Pointer,
  DescribedKind.Value,
  DescribedKind.Handle,
];

const pointerSize = koffi.sizeof("void *");

/** A release of the definition: it takes the context and the one thing it frees, and returns nothing. */
export class ReleaseCall {
  readonly #proto: KoffiType;

  constructor(
    readonly operation: DescribedOperation,
    readonly functionPointer: object | null,
    readonly context: object | null,
  ) {
    this.#proto = koffi.proto("void", operation.parameters.map(() => "void *"));
  }

  /** Frees `pointer`; a release the provider left NULL frees nothing. */
  free(pointer: object): void {
    if (this.functionPointer === null) {
      return;
    }
    const parameters = this.operation.parameters.map((parameter) => (parameter.kind === DescribedKind.Context ? this.context : pointer));
    koffi.call(this.functionPointer, this.#proto, ...parameters);
  }
}

/** An answer slot of one call: what the provider writes into, and how it is read and freed. */
interface AnswerSlot {
  readonly parameter: DescribedParameter;
  readonly block: object;
  readonly type: LaidOutType | undefined;
}

/** The refusal of one call, read for its `detail` and `fix` and freed by the release it names. */
interface RefusalSlot {
  readonly parameter: DescribedParameter;
  readonly block: object;
  readonly type: LaidOutType;
}

interface PreparedCall {
  readonly parameters: unknown[];
  readonly answers: AnswerSlot[];
  readonly refusal: RefusalSlot | undefined;
}

/** What a caller of the bound object's method hands it: one value per input parameter, keyed by its name. */
export type OperationInput = Readonly<Record<string, unknown>>;

/**
 * One operation of a described definition, its prototype built once at the bind and its parameters checked against
 * what this binding marshals.
 */
export class OperationCall {
  readonly name: string;
  /** The parameters a caller writes: every input but the context and a size counting another parameter. */
  readonly inputNames: readonly string[];
  readonly #operation: DescribedOperation;
  readonly #proto: KoffiType;
  readonly #counted: ReadonlySet<string>;

  /** @throws DescriptionLayoutError for a parameter this binding cannot marshal, or a release that is no release. */
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
    operation.parameters.forEach((parameter) => this.#refuseUnbindable(parameter));
    this.inputNames = operation.parameters
      .filter((parameter) => parameter.role === DescribedRole.Input && parameter.kind !== DescribedKind.Context && !this.#counted.has(parameter.name))
      .map((parameter) => parameter.name);
    this.#proto = koffi.proto(
      "int",
      operation.parameters.map((parameter) => (parameter.role === DescribedRole.Input && isScalarKind(parameter.kind) ? scalarTypes[parameter.kind]! : "void *")),
    );
  }

  #refuse(detail: string): DescriptionLayoutError {
    return new DescriptionLayoutError(this.definition, `its operation ${this.name} ${detail}`);
  }

  #refuseUnbindable(parameter: DescribedParameter): void {
    const allowed = parameter.role === DescribedRole.Input ? inputKinds : parameter.role === DescribedRole.Answer ? answerKinds : [DescribedKind.Pointer];
    if (!allowed.includes(parameter.kind)) {
      throw this.#refuse(`takes ${parameter.name} of kind ${parameter.kind} in role ${parameter.role}, which this binding cannot marshal`);
    }
    const pointsAtValue = parameter.kind === DescribedKind.Pointer && parameter.element === DescribedKind.Value;
    if (parameter.role !== DescribedRole.Input && pointsAtValue) {
      throw this.#refuse(`answers ${parameter.name} as a pointer to a value, which is answered as a tree`);
    }
    if (parameter.role !== DescribedRole.Input && parameter.release !== null && !this.releases.has(parameter.release)) {
      throw this.#refuse(`frees ${parameter.name} by ${parameter.release}, which is no release of the definition`);
    }
    if (parameter.role === DescribedRole.Refusal) {
      this.#refuseRefusalType(parameter);
    }
  }

  #refuseRefusalType(parameter: DescribedParameter): void {
    const type = this.layouts.type(parameter.type);
    for (const text of ["detail", "fix"]) {
      if (type.members.get(text)?.kind !== DescribedKind.Text) {
        throw this.#refuse(`refuses through ${type.described.name}, which carries no ${text} text`);
      }
    }
  }

  /**
   * Calls the operation with `input`, every answer copied out and released before it settles.
   *
   * @returns the answer on OK, `none` on NONE.
   * @throws DescribedCallError for any other status, TypeError for an input its parameter does not hold.
   */
  invoke(input: OperationInput, context: StructContext): unknown {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new TypeError(`${this.name} takes its inputs as one object, keyed by parameter name.`);
    }
    refuseUnknownNames(input, this.inputNames, `${this.name}'s input`);
    const arena = new CallArena();
    try {
      const writer = new StructWriter(context, arena);
      const prepared = this.#prepare(writer, input);
      if (this.functionPointer === null) {
        throw new Error(`${this.definition}'s ${this.name} is NULL in the struct its library answered.`);
      }
      const status = koffi.call(this.functionPointer, this.#proto, ...prepared.parameters) as number;
      return this.#outcome(writer, status, prepared);
    } finally {
      arena.free();
    }
  }

  #prepare(writer: StructWriter, input: OperationInput): PreparedCall {
    const counts = new Map<string, number>();
    const answers: AnswerSlot[] = [];
    let refusal: RefusalSlot | undefined;
    const parameters = this.#operation.parameters.map((parameter) => {
      const where = `${this.name}'s ${parameter.name}`;
      if (parameter.kind === DescribedKind.Context) {
        return this.context;
      }
      if (parameter.role === DescribedRole.Answer) {
        const slot = this.#answerSlot(writer, parameter, where);
        answers.push(slot);
        return slot.block;
      }
      if (parameter.role === DescribedRole.Refusal) {
        const type = this.layouts.type(parameter.type);
        refusal = { parameter, type, block: writer.allocateStruct(type, undefined, where) };
        return refusal.block;
      }
      if (this.#counted.has(parameter.name)) {
        return 0;
      }
      if (isScalarKind(parameter.kind)) {
        return scalarForC(parameter.kind, input[parameter.name], where);
      }
      const written = writer.writePointed(parameter.kind, parameter.element, parameter.type, input[parameter.name], where);
      if (parameter.count !== null) {
        counts.set(parameter.count, written.count);
      }
      return written.pointer;
    });
    this.#operation.parameters.forEach((parameter, index) => {
      if (counts.has(parameter.name)) {
        parameters[index] = counts.get(parameter.name)!;
      }
    });
    return { parameters, answers, refusal };
  }

  #answerSlot(writer: StructWriter, parameter: DescribedParameter, where: string): AnswerSlot {
    if (parameter.kind === DescribedKind.Pointer) {
      const type = this.layouts.type(parameter.type);
      return { parameter, type, block: writer.allocateStruct(type, undefined, where) };
    }
    if (parameter.kind === DescribedKind.Value) {
      const block = writer.arena.allocate(valueTreeSize);
      koffi.encode(block, 0, "uint32_t", valueTreeSize);
      return { parameter, type: undefined, block };
    }
    return { parameter, type: undefined, block: writer.arena.allocate(Math.max(pointerSize, 8)) };
  }

  #outcome(writer: StructWriter, status: number, prepared: PreparedCall): unknown {
    const handles: DescribedHandle[] = [];
    try {
      if (status === Status.Ok) {
        return this.#answer(prepared.answers.map((slot) => [slot.parameter.name, this.#readAnswer(writer, slot, handles)] as const));
      }
      if (status === Status.None) {
        return none;
      }
      throw this.#failure(status, prepared.refusal);
    } catch (error) {
      handles.forEach((handle) => handle.release());
      throw error;
    } finally {
      prepared.answers.forEach((slot) => this.#releaseAnswer(slot));
      if (prepared.refusal?.parameter.release != null) {
        this.releases.get(prepared.refusal.parameter.release)!.free(prepared.refusal.block);
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
    const { parameter, block } = slot;
    if (slot.type !== undefined) {
      return writer.readStruct(block, 0, slot.type, handles);
    }
    if (parameter.kind === DescribedKind.Value) {
      return readValue(block, valueTreeRootOffset);
    }
    if (isScalarKind(parameter.kind)) {
      return scalarFromC(parameter.kind, koffi.decode(block, 0, scalarTypes[parameter.kind]!));
    }
    const pointer = koffi.decode(block, 0, "void *") as object | null;
    return writer.readPointed(parameter.kind, parameter.element, parameter.type, parameter.release, pointer, 0, handles) ?? null;
  }

  /** A struct or tree answer is freed through what was handed in; a text answer through the text the provider wrote. */
  #releaseAnswer(slot: AnswerSlot): void {
    const { parameter, block } = slot;
    if (parameter.release === null || parameter.kind === DescribedKind.Handle) {
      return;
    }
    const release = this.releases.get(parameter.release)!;
    if (parameter.kind === DescribedKind.Text) {
      const text = koffi.decode(block, 0, "void *") as object | null;
      if (text !== null) {
        release.free(text);
      }
      return;
    }
    release.free(block);
  }

  #failure(status: number, refusal: RefusalSlot | undefined): DescribedCallError {
    if (status !== Status.Refused || refusal === undefined) {
      return new DescribedCallError(this.name, status, null, null);
    }
    const text = (name: string): string | null => koffi.decode(refusal.block, refusal.type.members.get(name)!.offset, "const char *") as string | null;
    return new DescribedCallError(this.name, status, text("detail"), text("fix"));
  }
}
