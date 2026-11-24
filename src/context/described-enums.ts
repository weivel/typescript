/**
 * The enums a description carries, each by the name its header spells, holding its entries' numbers by the names the
 * header spells them, as `services.enumsOf` and `capabilities.enumsOf` answer them; frozen, with no prototype.
 */
export type DescribedEnums = Readonly<Record<string, Readonly<Record<string, number>>>>;

const enumsByObject = new WeakMap<object, DescribedEnums>();

/** Records the enums of the description that bound `object`, so `describedEnumsOf` answers them. */
export function rememberDescribedEnums(object: object, enums: DescribedEnums): void {
  enumsByObject.set(object, enums);
}

/** The enums of the description that bound `object`, or undefined for anything no description bound. */
export function describedEnumsOf(object: unknown): DescribedEnums | undefined {
  return typeof object === "object" && object !== null ? enumsByObject.get(object) : undefined;
}
