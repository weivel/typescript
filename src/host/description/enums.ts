import type { DescribedEnums } from "../../context/described-enums.js";
import { Status } from "../../core/constants.js";
import { DescriptionLayoutError } from "./layouts.js";
import type { DescribedEnum, Description } from "./reader.js";

const statusName = "weivel_status";

/**
 * `weivel_status` as `core.h` spells it: every operation a description lists answers one, as the error of a call that
 * answered neither OK nor NONE carries it, though a description need not list it, since a role fixes it.
 */
const statusEnum: DescribedEnum = {
  name: statusName,
  entries: [
    { name: "WEIVEL_STATUS_OK", number: Status.Ok },
    { name: "WEIVEL_STATUS_NONE", number: Status.None },
    { name: "WEIVEL_STATUS_MALFORMED", number: Status.Malformed },
    { name: "WEIVEL_STATUS_REFUSED", number: Status.Refused },
    { name: "WEIVEL_STATUS_OUT_OF_MEMORY", number: Status.OutOfMemory },
  ],
};

function frozenRecord<Value>(entries: readonly (readonly [string, Value])[]): Readonly<Record<string, Value>> {
  return Object.freeze(Object.assign(Object.create(null) as Record<string, Value>, Object.fromEntries(entries)));
}

function entriesByName(described: DescribedEnum): Readonly<Record<string, number>> {
  return frozenRecord(described.entries.map((entry) => [entry.name, entry.number] as const));
}

function isCoreStatus(listed: DescribedEnum): boolean {
  const core = entriesByName(statusEnum);
  return listed.entries.length === statusEnum.entries.length && listed.entries.every((entry) => core[entry.name] === entry.number);
}

/**
 * A description's enums by name, each its entries' numbers by name, with `weivel_status` beside them where the
 * description lists none.
 *
 * @throws DescriptionLayoutError for a description listing a `weivel_status` that is not `core.h`'s.
 */
export function enumsByName(description: Description): DescribedEnums {
  const listed = description.enums.find((described) => described.name === statusName);
  if (listed !== undefined && !isCoreStatus(listed)) {
    throw new DescriptionLayoutError(description.definition, `it lists a ${statusName} that is not core.h's`);
  }
  const enums = listed === undefined ? [...description.enums, statusEnum] : description.enums;
  return frozenRecord(enums.map((described) => [described.name, entriesByName(described)] as const));
}
