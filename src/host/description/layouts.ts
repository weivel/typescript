import koffi from "koffi";
import { standardStructs } from "../../standard/declarations.js";
import { DescribedKind, lastKnownKind } from "./layout.js";
import type { DescribedMember, DescribedType, Description } from "./reader.js";
import { scalarTypes } from "./scalars.js";
import { valueNodeSize } from "./values.js";

type KoffiType = ReturnType<typeof koffi.opaque>;

/** One described struct with the koffi struct built for it, which the description's offsets were checked against. */
export interface LaidOutType {
  readonly described: DescribedType;
  readonly members: ReadonlyMap<string, DescribedMember>;
  /** The members a caller writes and an answer carries: all but a leading size, a count, the context and storage. */
  readonly visible: readonly DescribedMember[];
}

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
  readonly #laidOut = new Map<string, LaidOutType>();
  readonly #building = new Set<string>();

  /** @throws DescriptionLayoutError for any type whose layout disagrees with koffi's, or a kind this binding does not know. */
  constructor(description: Description) {
    this.#description = description;
    description.types.forEach((type) => this.#byName.set(type.name, type));
    description.types.forEach((type) => this.#build(type.name));
    description.types.forEach((type) =>
      type.members.forEach((member) => this.refuseUnreachableElement(member.kind, member.element, member.type, `its member ${type.name}.${member.name}`)),
    );
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
    this.#laidOut.set(name, {
      described: type,
      members: new Map(type.members.map((member) => [member.name, member])),
      visible: visibleMembers(type),
    });
    return koffiType;
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
