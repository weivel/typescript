import koffi from "koffi";
import { standardStructs } from "../../standard/declarations.js";
import { DescribedKind, lastKnownKind } from "./layout.js";
import type { DescribedMember, DescribedType, Description } from "./reader.js";
import { scalarTypes } from "./scalars.js";
import { valueNodeSize } from "./values.js";

type KoffiType = ReturnType<typeof koffi.opaque>;

/** What a member or a parameter is, as far as writing and reading what it reaches goes. */
export interface Reached {
  readonly name: string;
  readonly kind: number;
  readonly element: number;
  readonly type: string | null;
  readonly release: string | null;
}

/** How what a member or a parameter reaches is written and read, worked out at the bind so a call looks nothing up. */
export interface ReachPlan {
  readonly reached: Reached;
  /** The struct a STRUCT member embeds, or a POINTER or an ARRAY of structs reaches. */
  readonly target: LaidOutType | undefined;
  /** How many bytes one element it reaches takes, 0 when it reaches none. */
  readonly stride: number;
  /**
   * Whether koffi writes what it reaches from a JavaScript value during the call; otherwise the binding writes it into
   * the call's arena and hands koffi the address.
   */
  readonly marshalledByKoffi: boolean;
}

/** The plan of one visible member of a struct. */
export interface MemberPlan extends ReachPlan {
  readonly member: DescribedMember;
  /** The member counting this one, or null for a member nothing counts. */
  readonly count: DescribedMember | null;
}

/** One described struct with the koffi struct built for it, which the description's offsets were checked against. */
export interface LaidOutType {
  readonly described: DescribedType;
  readonly members: ReadonlyMap<string, DescribedMember>;
  /** The members a caller writes and an answer carries: all but a leading size, a count, the context and storage. */
  readonly visible: readonly DescribedMember[];
  /** The plan of every visible member, in the order of `visible`. */
  readonly plans: readonly MemberPlan[];
  /** Whether the struct opens with its own size, which the binding sets. */
  readonly leadingSize: boolean;
  /** The struct as the binding writes it into its arena: every pointer a `void *` it fills itself. */
  readonly arenaType: KoffiType;
  /** The same struct as koffi writes it from a JavaScript value during a call: the texts, arrays and structs it reaches typed. */
  readonly callType: KoffiType;
}

class LaidOut implements LaidOutType {
  plans: readonly MemberPlan[] = [];
  callType: KoffiType;

  constructor(
    readonly described: DescribedType,
    readonly members: ReadonlyMap<string, DescribedMember>,
    readonly visible: readonly DescribedMember[],
    readonly leadingSize: boolean,
    readonly arenaType: KoffiType,
  ) {
    this.callType = arenaType;
  }
}

/**
 * @implNote Every load registers one globally named koffi struct per described struct and never frees it: koffi
 * needs a name for a struct to point at itself, and frees no type it has registered.
 */
let callTypeSequence = 0;

/** A description that does not hold for this platform's layout, or that this binding cannot bind: the caller's mistake. */
export class DescriptionLayoutError extends Error {
  constructor(definition: string, detail: string) {
    super(`The description of ${definition} cannot be bound: ${detail}.`);
    this.name = "DescriptionLayoutError";
  }
}

const pointerSized: readonly number[] = [
  DescribedKind.Text,
  DescribedKind.Texts,
  DescribedKind.Bytes,
  DescribedKind.Pointer,
  DescribedKind.Array,
  DescribedKind.Handle,
  DescribedKind.Context,
  DescribedKind.Storage,
];

/** A U32 called `size` at offset 0: the struct's own size, set by the binding and never answered. */
export function isLeadingSize(member: DescribedMember): boolean {
  return member.kind === DescribedKind.U32 && member.name === "size" && member.offset === 0;
}

/** The types koffi writes a text, texts and bytes as, from a string, an array of them and a Uint8Array. */
const textCallTypes: Readonly<Record<number, string>> = {
  [DescribedKind.Text]: "const char *",
  [DescribedKind.Texts]: "const char **",
  [DescribedKind.Bytes]: "const uint8_t *",
};

function isTextLike(kind: number): boolean {
  return kind in textCallTypes;
}

function countedNames(type: DescribedType): Set<string> {
  return new Set(type.members.flatMap((member) => (member.count === null ? [] : [member.count])));
}

function visibleMembers(type: DescribedType): DescribedMember[] {
  const counts = countedNames(type);
  return type.members.filter(
    (member) =>
      !isLeadingSize(member) &&
      !counts.has(member.name) &&
      member.kind !== DescribedKind.Context &&
      member.kind !== DescribedKind.Storage,
  );
}

/**
 * The koffi layouts of every struct a description names, each built once from the description's members and checked
 * against it: the struct's size, and every member's offset and size, must be what koffi computes for the struct
 * built from the members in their order.
 */
export class DescribedLayouts {
  readonly #description: Description;
  readonly #byName = new Map<string, DescribedType>();
  readonly #built = new Map<string, KoffiType>();
  readonly #laidOut = new Map<string, LaidOut>();
  readonly #building = new Set<string>();
  readonly #callNames = new Map<string, string>();
  readonly #callTyped = new Set<string>();
  readonly #arenaReached = new Set<DescribedMember>();

  /** @throws DescriptionLayoutError for any type whose layout disagrees with koffi's, or a kind this binding does not know. */
  constructor(description: Description) {
    this.#description = description;
    description.types.forEach((type) => this.#byName.set(type.name, type));
    description.types.forEach((type) => this.#build(type.name));
    description.types.forEach((type) =>
      type.members.forEach((member) => this.refuseUnreachableElement(member.kind, member.element, member.type, `its member ${type.name}.${member.name}`)),
    );
    description.types.forEach((type) => this.#buildCallType(type.name));
    this.#laidOut.forEach((laidOut) => {
      laidOut.plans = laidOut.visible.map((member) => this.#planOf(laidOut, member));
    });
  }

  /**
   * Resolves what a POINTER or an ARRAY reaches, so a description whose element this binding cannot marshal is refused
   * whole at the bind rather than at the first call reaching it.
   *
   * @throws DescriptionLayoutError for an element of a kind this binding does not know or cannot hold there, or a
   * struct element the description does not describe.
   */
  refuseUnreachableElement(kind: number, element: number, type: string | null, where: string): void {
    if (kind !== DescribedKind.Pointer && kind !== DescribedKind.Array) {
      return;
    }
    if (element < DescribedKind.U32 || element > lastKnownKind) {
      throw this.#refuse(`${where} reaches elements of kind ${element}, which this binding does not know`);
    }
    if (kind === DescribedKind.Array) {
      this.elementSize(element, type);
    } else if (element === DescribedKind.Struct) {
      this.type(type);
    } else if (element !== DescribedKind.Value) {
      throw this.#refuse(`${where} points at an element of kind ${element}, where a pointer points at a struct or a value`);
    }
  }

  /** @throws DescriptionLayoutError for a name the description holds no struct for. */
  type(name: string | null): LaidOutType {
    return this.#laidOutType(name);
  }

  #laidOutType(name: string | null): LaidOut {
    const laidOut = name === null ? undefined : this.#laidOut.get(name);
    if (laidOut === undefined) {
      throw this.#refuse(`it names ${name} as a struct and describes none by that name`);
    }
    return laidOut;
  }

  /** How many bytes one element of an array of `element` takes, `type` naming a struct element. */
  elementSize(element: number, type: string | null): number {
    if (element === DescribedKind.Struct) {
      return this.type(type).described.size;
    }
    if (element === DescribedKind.Value) {
      return valueNodeSize;
    }
    const scalar = scalarTypes[element];
    if (scalar === undefined) {
      throw this.#refuse(`an array holds elements of kind ${element}, which this binding cannot lay out`);
    }
    return koffi.sizeof(scalar);
  }

  #refuse(detail: string): DescriptionLayoutError {
    return new DescriptionLayoutError(this.#description.definition, detail);
  }

  #build(name: string): KoffiType {
    const built = this.#built.get(name);
    if (built !== undefined) {
      return built;
    }
    const type = this.#byName.get(name);
    if (type === undefined) {
      throw this.#refuse(`it embeds ${name}, which it does not describe`);
    }
    if (this.#building.has(name)) {
      throw this.#refuse(`${name} holds itself by value`);
    }
    this.#building.add(name);
    const fields = this.#fieldsOf(type);
    const koffiType = koffi.struct(Object.fromEntries(fields.map((field) => [field.name, field.type])));
    this.#building.delete(name);
    this.#check(type, koffiType, fields);
    this.#built.set(name, koffiType);
    const members = new Map(type.members.map((member) => [member.name, member]));
    this.#laidOut.set(name, new LaidOut(type, members, visibleMembers(type), type.members.some(isLeadingSize), koffiType));
    return koffiType;
  }

  #planOf(laidOut: LaidOut, member: DescribedMember): MemberPlan {
    const plan = this.planOf(member);
    return {
      ...plan,
      member,
      count: member.count === null ? null : laidOut.members.get(member.count)!,
      marshalledByKoffi: plan.marshalledByKoffi && !this.#arenaReached.has(member),
    };
  }

  /** The plan of what a member or a parameter reaches, koffi writing it during the call wherever its kind lets it. */
  planOf(reached: Reached): ReachPlan {
    const reaches = reached.kind === DescribedKind.Pointer || reached.kind === DescribedKind.Array;
    const reachesStruct = reached.kind === DescribedKind.Struct || (reaches && reached.element === DescribedKind.Struct);
    return {
      reached,
      target: reachesStruct ? this.type(reached.type) : undefined,
      stride: reaches ? this.elementSize(reached.element, reached.type) : 0,
      marshalledByKoffi: reaches ? reached.element !== DescribedKind.Value : isTextLike(reached.kind),
    };
  }

  /** The type koffi is handed an input parameter of `plan` as, matching what `StructWriter.written` answers for it. */
  inputCallType(plan: ReachPlan): string | KoffiType {
    const { kind, element } = plan.reached;
    const text = textCallTypes[kind];
    if (text !== undefined) {
      return text;
    }
    if ((kind === DescribedKind.Pointer || kind === DescribedKind.Array) && plan.marshalledByKoffi) {
      return element === DescribedKind.Struct ? koffi.pointer(plan.target!.callType) : koffi.pointer(scalarTypes[element]!);
    }
    return "void *";
  }

  /**
   * Builds the struct koffi writes from a JavaScript value during a call, every struct it embeds built first, named so
   * a struct pointing at itself can name itself.
   *
   * @returns whether its call type is complete; false while it, or a struct it embeds however deep, is still being
   * built, so a pointer reaching it from there stays a `void *` the binding writes into its arena, since koffi resolves
   * no name it has not seen yet.
   */
  #buildCallType(name: string): boolean {
    if (this.#callTyped.has(name)) {
      return true;
    }
    if (this.#callNames.has(name)) {
      return false;
    }
    const laidOut = this.#laidOutType(name);
    const embedded = laidOut.described.members.filter((member) => member.kind === DescribedKind.Struct);
    if (!embedded.every((member) => this.#buildCallType(member.type!))) {
      return false;
    }
    const koffiName = `weivel_described_call_${callTypeSequence++}`;
    this.#callNames.set(name, koffiName);
    const fields = this.#fieldsOf(laidOut.described).map((field) => {
      const member = laidOut.members.get(field.name);
      return { ...field, type: member === undefined ? field.type : this.#callField(name, member) };
    });
    const callType = koffi.struct(koffiName, Object.fromEntries(fields.map((field) => [field.name, field.type])));
    this.#check(laidOut.described, callType, fields);
    laidOut.callType = callType;
    this.#callTyped.add(name);
    return true;
  }

  #callField(owner: string, member: DescribedMember): string | KoffiType {
    switch (member.kind) {
      case DescribedKind.Text:
      case DescribedKind.Texts:
      case DescribedKind.Bytes:
        return textCallTypes[member.kind]!;
      case DescribedKind.Struct:
        if (!this.#callTyped.has(member.type!)) {
          throw new Error(`${owner}.${member.name} would embed ${member.type}'s arena layout in a call type, which koffi would write wrong.`);
        }
        return this.#laidOutType(member.type).callType;
      case DescribedKind.Pointer:
      case DescribedKind.Array:
        return this.#reachedCallField(owner, member);
      default:
        return this.#memberType(member);
    }
  }

  #reachedCallField(owner: string, member: DescribedMember): string | KoffiType {
    if (member.element === DescribedKind.Value) {
      return "void *";
    }
    if (member.element !== DescribedKind.Struct) {
      return koffi.pointer(scalarTypes[member.element]!);
    }
    if (member.type === owner) {
      return `${this.#callNames.get(owner)!} *`;
    }
    if (!this.#buildCallType(member.type!)) {
      this.#arenaReached.add(member);
      return "void *";
    }
    return koffi.pointer(this.#laidOutType(member.type).callType);
  }

  /** Every field of the struct in declaration order: a definition's operations, which it does not list as members, among them. */
  #fieldsOf(type: DescribedType): { name: string; type: string | KoffiType; offset: number; size: number }[] {
    const fields = type.members.map((member) => ({ name: member.name, type: this.#memberType(member), offset: member.offset, size: member.size }));
    if (type.name === this.#description.definition) {
      const pointerSize = koffi.sizeof("void *");
      const operations = this.#description.operations.map((operation) => ({ name: operation.name, type: "void *", offset: operation.offset, size: pointerSize }));
      return [...fields, ...operations].sort((left, right) => left.offset - right.offset);
    }
    return fields;
  }

  #memberType(member: DescribedMember): string | KoffiType {
    if (member.kind < DescribedKind.U32 || member.kind > lastKnownKind) {
      throw this.#refuse(`its member ${member.name} is of kind ${member.kind}, which this binding does not know`);
    }
    if (pointerSized.includes(member.kind)) {
      return "void *";
    }
    if (member.kind === DescribedKind.Struct) {
      if (member.type === null) {
        throw this.#refuse(`its member ${member.name} holds a struct and names none`);
      }
      return this.#build(member.type);
    }
    if (member.kind === DescribedKind.Value) {
      return standardStructs.weivel_standard_value;
    }
    return scalarTypes[member.kind]!;
  }

  #check(type: DescribedType, koffiType: KoffiType, fields: readonly { name: string; offset: number; size: number; type: string | KoffiType }[]): void {
    for (const field of fields) {
      const offset = koffi.offsetof(koffiType, field.name);
      const size = koffi.sizeof(field.type);
      if (offset !== field.offset || size !== field.size) {
        throw this.#refuse(
          `${type.name}.${field.name} is described at offset ${field.offset} and size ${field.size}, where this platform lays it out at offset ${offset} and size ${size}`,
        );
      }
    }
    if (koffi.sizeof(koffiType) !== type.size) {
      throw this.#refuse(`${type.name} is described as ${type.size} bytes, where this platform lays it out in ${koffi.sizeof(koffiType)}`);
    }
  }
}
