import koffi from "koffi";
import { Status } from "../../core/constants.js";
import { LibraryUnloadedError } from "../libraries.js";
import { CallArena } from "./arena.js";
import { DescribedKind, DescribedRole } from "./layout.js";
import type { DescribedLayouts, LaidOutType, ReachPlan } from "./layouts.js";
import { none, DescribedCallError, OperationNotOfferedError } from "./outcome.js";
import type { DescribedOperation, DescribedParameter } from "./reader.js";
import { isScalarKind, scalarForC, scalarTypes } from "./scalars.js";
import { Carried, littleEndian, refuseUnknownNames, scalarAt, StructWriter, type StructContext } from "./structs.js";
import { readValue, valueTreeRootOffset, valueTreeSize } from "./values.js";

type KoffiType = ReturnType<typeof koffi.opaque>;
type WorkerFunction = ReturnType<koffi.IKoffiLib["func"]>;

const pointerSize = koffi.sizeof("void *");
const releasePrototype = koffi.proto("void", ["void *", "void *"]);

/** A release of the definition: it takes the context and the one thing it frees, and returns nothing. */
export class ReleaseCall {
  constructor(
    readonly functionPointer: object | null,
    readonly context: object | null,
  ) {}

  /** Frees `pointer`; a release the provider left NULL frees nothing. */
  free(pointer: object): void {
    if (this.functionPointer === null) {
      return;
    }
    koffi.call(this.functionPointer, releasePrototype, this.context, pointer);
  }
}

/** Counts the calls running on koffi's worker thread, so the binary they run in is not closed under them. */
export interface CallTracking {
  begin(): void;
  end(): void;
}

/** What one bound definition hands every call of an operation: its own function, context, releases and holdings. */
export interface OperationTarget {
  readonly symbol: string;
  readonly functionPointer: object | null;
  readonly context: object | null;
  readonly releases: ReadonlyMap<string, ReleaseCall>;
  readonly structs: StructContext;
  readonly calls: CallTracking;
  /** Whether the binary is still open, so a provider's release may still be called. */
  readonly isOpen: () => boolean;
}

/** How large a block an answer or a refusal is handed, and the size its leading `size` is set to, if it has one. */
interface BlockShape {
  readonly byteSize: number;
  readonly leadingSize: number | undefined;
}

/** A block an operation hands its provider as an answer or a refusal, emptied before the call, its leading size set. */
class AnswerBlock {
  readonly block: object;
  readonly view: DataView;
  readonly #bytes: Uint8Array;

  constructor(readonly shape: BlockShape) {
    this.block = koffi.alloc("uint8_t", shape.byteSize) as object;
    const memory = koffi.view(this.block, shape.byteSize);
    this.view = new DataView(memory);
    this.#bytes = new Uint8Array(memory);
  }

  empty(): this {
    this.#bytes.fill(0);
    if (this.shape.leadingSize !== undefined) {
      this.view.setUint32(0, this.shape.leadingSize, littleEndian);
    }
    return this;
  }

  free(): void {
    koffi.free(this.block);
  }
}

const fixedBlocks = new FinalizationRegistry<readonly AnswerBlock[]>((blocks) => blocks.forEach((block) => block.free()));

/** An answer slot of an operation: what the provider writes into, and how it is read and freed. */
interface AnswerSlot {
  readonly parameter: DescribedParameter;
  readonly plan: ReachPlan;
  readonly shape: BlockShape;
  readonly type: LaidOutType | undefined;
}

/** The refusal of an operation, read for its `detail` and `fix` and freed by the release it names. */
interface RefusalSlot {
  readonly parameter: DescribedParameter;
  readonly shape: BlockShape;
  readonly type: LaidOutType;
}

/** The blocks one call hands its provider: one per answer slot, in slot order, and the refusal's. */
interface CallBlocks {
  readonly answers: readonly AnswerBlock[];
  readonly refusal: AnswerBlock | undefined;
  /** Whether the blocks were allocated for this call alone, so the call frees them. */
  readonly ownedByCall: boolean;
}

/** What one parameter is handed, worked out at the bind. */
type ParameterStep =
  | { readonly role: "context" }
  | { readonly role: "answer"; readonly answerIndex: number }
  | { readonly role: "refusal" }
  | { readonly role: "count"; readonly parameter: DescribedParameter }
  | { readonly role: "scalar"; readonly parameter: DescribedParameter }
  | { readonly role: "reached"; readonly parameter: DescribedParameter; readonly plan: ReachPlan; readonly countIndex: number };

/** What a caller of the bound object's method hands it: one value per input parameter, keyed by its name. */
export type OperationInput = Readonly<Record<string, unknown>>;

/** How an operation is called: on the calling thread, or on koffi's worker thread for one its description marks blocking. */
export interface OperationOptions {
  readonly blocking: boolean;
}

/**
 * One operation of a described definition, its prototype, its parameter steps and its answer and refusal shapes built
 * once at the bind, from a description the standard's check passed, and shared by every definition the description
 * binds.
 *
 * @implNote An operation that runs on the calling thread and whose answer carries no definition hands its provider
 * the same blocks on every call: a call runs to its end there, the provider calls back into nothing, and every answer
 * is copied out and released before the call returns. A blocking operation allocates its blocks per call, since
 * calls may overlap on the worker thread, and so does an operation whose answer may carry a definition, since that
 * answer lives until its caller releases it.
 */
export class OperationCall {
  readonly name: string;
  /** The parameters a caller writes: every input but the context and a size counting another parameter. */
  readonly inputNames: readonly string[];
  readonly blocking: boolean;
  /** Whether an answer of this operation may carry a definition, and so lives until its caller releases it. */
  readonly keepsAnswers: boolean;
  /** The answer parameters, in the order the operation takes them. */
  readonly answerParameters: readonly DescribedParameter[];
  readonly #operation: DescribedOperation;
  readonly #proto: KoffiType;
  readonly #counted: ReadonlySet<string>;
  readonly #steps: readonly ParameterStep[];
  readonly #answers: readonly AnswerSlot[];
  readonly #refusal: RefusalSlot | undefined;
  readonly #fixed: CallBlocks | undefined;
  readonly #workers = new Map<bigint, WorkerFunction>();
  #calling = false;

  /** @throws DescriptionLayoutError for a parameter reaching an element this binding cannot marshal. */
  constructor(
    readonly definition: string,
    operation: DescribedOperation,
    readonly layouts: DescribedLayouts,
    options: OperationOptions,
  ) {
    this.name = operation.name;
    this.blocking = options.blocking;
    this.#operation = operation;
    this.#counted = new Set(operation.parameters.flatMap((parameter) => (parameter.count === null ? [] : [parameter.count])));
    operation.parameters.forEach((parameter) =>
      this.layouts.refuseUnreachableElement(parameter.kind, parameter.element, parameter.type, `its operation ${this.name}'s ${parameter.name}`),
    );
    this.inputNames = operation.parameters
      .filter((parameter) => parameter.role === DescribedRole.Input && parameter.kind !== DescribedKind.Context && !this.#counted.has(parameter.name))
      .map((parameter) => parameter.name);
    const answers: AnswerSlot[] = [];
    let refusal: RefusalSlot | undefined;
    this.#steps = operation.parameters.map((parameter) => {
      if (parameter.role === DescribedRole.Answer && parameter.kind !== DescribedKind.Context) {
        answers.push(this.#answerSlot(parameter));
        return { role: "answer", answerIndex: answers.length - 1 };
      }
      if (parameter.role === DescribedRole.Refusal) {
        const type = this.layouts.type(parameter.type);
        refusal = { parameter, type, shape: { byteSize: type.described.size, leadingSize: sizeOf(type) } };
        return { role: "refusal" };
      }
      return this.#stepOf(parameter);
    });
    this.#answers = answers;
    this.#refusal = refusal;
    this.answerParameters = answers.map((slot) => slot.parameter);
    this.keepsAnswers = answers.some((slot) => this.layouts.carriesDefinition(slot.parameter));
    if (!this.blocking && !this.keepsAnswers) {
      this.#fixed = this.#allocateBlocks(false);
      fixedBlocks.register(this, [...this.#fixed.answers, ...(this.#fixed.refusal === undefined ? [] : [this.#fixed.refusal])]);
    }
    this.#proto = koffi.proto(
      "int",
      this.#steps.map((step) => (step.role === "scalar" || step.role === "count" ? scalarTypes[step.parameter.kind]! : step.role === "reached" ? this.layouts.inputCallType(step.plan) : "void *")),
    );
  }

  #stepOf(parameter: DescribedParameter): ParameterStep {
    if (parameter.kind === DescribedKind.Context) {
      return { role: "context" };
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
      return { parameter, plan, type, shape: { byteSize: type.described.size, leadingSize: sizeOf(type) } };
    }
    if (parameter.kind === DescribedKind.Value) {
      return { parameter, plan, type: undefined, shape: { byteSize: valueTreeSize, leadingSize: valueTreeSize } };
    }
    return { parameter, plan, type: undefined, shape: { byteSize: Math.max(pointerSize, 8), leadingSize: undefined } };
  }

  #allocateBlocks(ownedByCall: boolean): CallBlocks {
    return {
      answers: this.#answers.map((slot) => new AnswerBlock(slot.shape)),
      refusal: this.#refusal === undefined ? undefined : new AnswerBlock(this.#refusal.shape),
      ownedByCall,
    };
  }

  /** Blocks emptied for one call: the operation's own fixed ones, or ones allocated for this call alone. */
  #blocksForCall(): CallBlocks {
    const blocks = this.#fixed ?? this.#allocateBlocks(true);
    blocks.answers.forEach((block) => block.empty());
    blocks.refusal?.empty();
    return blocks;
  }

  /**
   * Calls the operation with `input` through `target`, every answer copied out before it settles, and released then
   * unless it carries a definition, which lives until the caller calls the answer's `release()`. A blocking operation
   * runs on koffi's worker thread and answers a promise; every other one runs to its end before this returns.
   *
   * @returns the answer on OK, `none` on NONE.
   * @throws DescribedCallError for any other status; TypeError for an input its parameter does not hold, a name it
   * does not take or structs nested deeper than the standard's limit, and OperationNotOfferedError for an operation
   * the provider does not offer, each the caller's mistake, refused before anything is called.
   */
  invoke(input: OperationInput, target: OperationTarget): unknown {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new TypeError(`${this.name} takes its inputs as one object, keyed by parameter name.`);
    }
    if (target.functionPointer === null) {
      throw new OperationNotOfferedError(this.definition, this.name);
    }
    refuseUnknownNames(input, this.inputNames, `${this.name}'s input`);
    return this.blocking ? this.#invokeOnWorker(input, target, target.functionPointer) : this.#invokeHere(input, target, target.functionPointer);
  }

  #invokeHere(input: OperationInput, target: OperationTarget, functionPointer: object): unknown {
    if (this.#calling) {
      throw new Error(`${this.name} was called while a call of it was still running, which its answer blocks cannot hold.`);
    }
    this.#calling = this.#fixed !== undefined;
    const arena = new CallArena();
    const blocks = this.#blocksForCall();
    let prepared = false;
    try {
      const writer = new StructWriter(target.structs, arena);
      const parameters = this.#prepare(writer, input, blocks, target.context);
      prepared = true;
      const status = koffi.call(functionPointer, this.#proto, ...parameters) as number;
      return this.#outcome(writer, status, blocks, target);
    } finally {
      if (!prepared) {
        this.#freeOwned(blocks);
      }
      arena.free();
      this.#calling = false;
    }
  }

  #invokeOnWorker(input: OperationInput, target: OperationTarget, functionPointer: object): Promise<unknown> {
    const arena = new CallArena();
    const blocks = this.#blocksForCall();
    let writer: StructWriter;
    let parameters: unknown[];
    try {
      writer = new StructWriter(target.structs, arena);
      parameters = this.#prepare(writer, input, blocks, target.context);
    } catch (error) {
      this.#freeOwned(blocks);
      arena.free();
      return Promise.reject(error);
    }
    const worker = this.#workerOf(functionPointer);
    target.calls.begin();
    return new Promise((resolve, reject) => {
      worker.async(...parameters, (error: unknown, status: number) => {
        try {
          if (error !== null && error !== undefined) {
            this.#freeOwned(blocks);
            reject(error);
          } else if (!target.isOpen()) {
            this.#releaseUnread(blocks, target);
            reject(new LibraryUnloadedError(target.symbol));
          } else {
            resolve(this.#outcome(writer, status, blocks, target));
          }
        } catch (outcomeError) {
          reject(outcomeError);
        } finally {
          arena.free();
          target.calls.end();
        }
      });
    });
  }

  /** The operation at `functionPointer` as a koffi function, whose `async` calls it on the worker thread. */
  #workerOf(functionPointer: object): WorkerFunction {
    const address = koffi.address(functionPointer);
    let worker = this.#workers.get(address);
    if (worker === undefined) {
      worker = koffi.decode(functionPointer, this.#proto) as WorkerFunction;
      this.#workers.set(address, worker);
    }
    return worker;
  }

  #prepare(writer: StructWriter, input: OperationInput, blocks: CallBlocks, context: object | null): unknown[] {
    const parameters = new Array<unknown>(this.#steps.length);
    this.#steps.forEach((step, index) => {
      switch (step.role) {
        case "context":
          parameters[index] = context;
          return;
        case "answer":
          parameters[index] = blocks.answers[step.answerIndex]!.block;
          return;
        case "refusal":
          parameters[index] = blocks.refusal!.block;
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

  #outcome(writer: StructWriter, status: number, blocks: CallBlocks, target: OperationTarget): unknown {
    const carried = new Carried();
    let kept = false;
    try {
      if (status === Status.Ok) {
        const answer = this.#answer(this.#answers.map((slot, index) => [slot.parameter.name, this.#readAnswer(writer, slot, blocks.answers[index]!, carried)] as const));
        kept = carried.definitions.length > 0;
        return kept ? this.#keep(answer as object, carried, blocks, target) : answer;
      }
      if (status === Status.None) {
        return none;
      }
      throw this.#failure(status, blocks.refusal);
    } catch (error) {
      carried.releaseAll();
      throw error;
    } finally {
      if (!kept) {
        this.#releaseAnswers(blocks, target);
      }
      this.#releaseRefusal(blocks, target);
      if (!kept && blocks.ownedByCall) {
        blocks.answers.forEach((block) => block.free());
      }
    }
  }

  /**
   * Gives an answer that carries a definition its own `release()`, kept among the library's holdings so its unload
   * releases it too: releasing ends every definition it carried, then frees the answer through the release its
   * description names.
   */
  #keep(answer: object, carried: Carried, blocks: CallBlocks, target: OperationTarget): object {
    const held = target.structs.holdings.keep(() => {
      carried.definitions.forEach((definition) => definition.end());
      if (target.isOpen()) {
        this.#releaseAnswers(blocks, target);
      }
      blocks.answers.forEach((block) => block.free());
    });
    Object.defineProperty(answer, "release", { value: () => held.release() });
    carried.definitions.forEach((definition) => Object.freeze(definition.bound));
    return answer;
  }

  /** Frees what a worker call answered after its binary was closed, reading none of it. */
  #releaseUnread(blocks: CallBlocks, target: OperationTarget): void {
    this.#releaseAnswers(blocks, target);
    this.#releaseRefusal(blocks, target);
    blocks.answers.forEach((block) => block.free());
  }

  #freeOwned(blocks: CallBlocks): void {
    if (blocks.ownedByCall) {
      blocks.answers.forEach((block) => block.free());
      blocks.refusal?.free();
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

  #readAnswer(writer: StructWriter, slot: AnswerSlot, block: AnswerBlock, carried: Carried): unknown {
    const { parameter } = slot;
    if (slot.type !== undefined) {
      return writer.readStruct(block.block, block.view, 0, slot.type, carried);
    }
    if (parameter.kind === DescribedKind.Value) {
      return readValue(block.block, valueTreeRootOffset);
    }
    if (isScalarKind(parameter.kind)) {
      return scalarAt(block.view, 0, parameter.kind);
    }
    return writer.readReached(slot.plan, block.block, 0, isNullPointer(block.view), 0, carried) ?? null;
  }

  /** A struct or tree answer is freed through what was handed in; the check lets no scalar or text answer name a release. */
  #releaseAnswers(blocks: CallBlocks, target: OperationTarget): void {
    this.#answers.forEach((slot, index) => {
      const { parameter } = slot;
      if (parameter.release !== null && parameter.kind !== DescribedKind.Handle) {
        target.releases.get(parameter.release)!.free(blocks.answers[index]!.block);
      }
    });
  }

  #releaseRefusal(blocks: CallBlocks, target: OperationTarget): void {
    if (this.#refusal?.parameter.release != null) {
      target.releases.get(this.#refusal.parameter.release)!.free(blocks.refusal!.block);
    }
    if (blocks.ownedByCall) {
      blocks.refusal?.free();
    }
  }

  #failure(status: number, refusal: AnswerBlock | undefined): DescribedCallError {
    if (status !== Status.Refused || refusal === undefined || this.#refusal === undefined) {
      return new DescribedCallError(this.name, status, null, null);
    }
    const members = this.#refusal.type.members;
    const text = (name: string): string | null => koffi.decode(refusal.block, members.get(name)!.offset, "const char *") as string | null;
    return new DescribedCallError(this.name, status, text("detail"), text("fix"));
  }
}

function sizeOf(type: LaidOutType): number | undefined {
  return type.leadingSize ? type.described.size : undefined;
}

function isNullPointer(view: DataView): boolean {
  return pointerSize === 8 ? view.getBigUint64(0, littleEndian) === 0n : view.getUint32(0, littleEndian) === 0;
}
