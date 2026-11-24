import type { DescribedEnums } from "../../context/described-enums.js";
import { Status } from "../../core/constants.js";
import type { DescribedEnum } from "./reader.js";

/**
 * `weivel_status` as `core.h` spells it: every operation a description lists answers one, as the error of a call that
 * answered neither OK nor NONE carries it, yet no description lists it, since a role fixes it.
 */
const statusEnum: readonly DescribedEnum[] = [
  {
    name: "weivel_status",
    entries: [
      { name: "WEIVEL_STATUS_OK", number: Status.Ok },
      { name: "WEIVEL_STATUS_NONE", number: Status.None },
      { name: "WEIVEL_STATUS_MALFORMED", number: Status.Malformed },
      { name: "WEIVEL_STATUS_REFUSED", number: Status.Refused },
      { name: "WEIVEL_STATUS_OUT_OF_MEMORY", number: Status.OutOfMemory },
    ],
  },
];

function frozenRecord<Value>(entries: readonly (readonly [string, Value])[]): Readonly<Record<string, Value>> {
  return Object.freeze(Object.assign(Object.create(null) as Record<string, Value>, Object.fromEntries(entries)));
}

function entriesByName(described: DescribedEnum): Readonly<Record<string, number>> {
  return frozenRecord(described.entries.map((entry) => [entry.name, entry.number] as const));
}

/** A description's enums by name, with `weivel_status` beside them, each its entries' numbers by name. */
export function enumsByName(enums: readonly DescribedEnum[]): DescribedEnums {
  return frozenRecord([...enums, ...statusEnum].map((described) => [described.name, entriesByName(described)] as const));
}
