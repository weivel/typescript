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

/** The entries a plugin reads of each enum, by the names the header spells them. */
export type EnumNames = Readonly<Record<string, readonly string[]>>;

/** The enums `names` asks for, each holding exactly the entries it names. */
export type RequiredEnums<Names extends EnumNames> = { readonly [Enum in keyof Names]: Readonly<Record<Names[Enum][number], number>> };

function requiredEntries(described: Readonly<Record<string, number>>, entries: readonly string[], refuse: (missing: string) => TypeError): Readonly<Record<string, number>> {
  const read = Object.create(null) as Record<string, number>;
  for (const entry of entries) {
    const number = described[entry];
    if (number === undefined) throw refuse(entry);
    read[entry] = number;
  }
  return Object.freeze(read);
}

/**
 * The enums and entries `names` asks for, read from `enums`, which `of` names in the error.
 *
 * @throws TypeError naming the first enum or entry `enums` lacks, and for no enums at all.
 */
export function requireEnums<const Names extends EnumNames>(enums: DescribedEnums | undefined, names: Names, of: string): RequiredEnums<Names> {
  if (enums === undefined) throw new TypeError(`${of} carries no described enums.`);
  const read = Object.create(null) as Record<string, Readonly<Record<string, number>>>;
  for (const [name, entries] of Object.entries(names)) {
    const described = enums[name];
    if (described === undefined) throw new TypeError(`The description of ${of} lists no enum ${name}.`);
    read[name] = requiredEntries(described, entries, (entry) => new TypeError(`The enum ${name} of ${of} has no entry ${entry}.`));
  }
  return Object.freeze(read) as RequiredEnums<Names>;
}
