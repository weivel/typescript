import type { UiComponent } from "../index.js";
import { schemaIssues, type ValidationIssue } from "../engine/validation.js";
import * as validators from "./ui-data.generated.js";

export type {
  UiBadgeAnswer,
  UiColumn,
  UiData,
  UiEntriesAnswer,
  UiEntry,
  UiItem,
  UiItems,
  UiItemState,
  UiMeasureAnswer,
  UiSeries,
  UiSeriesAnswer,
  UiTextAnswer,
} from "./ui-data.generated.js";

const BINDABLE: ReadonlySet<string> = new Set(validators.UI_DATA_DEFINITIONS);

type Validator = ((value: unknown) => boolean) & { errors?: Parameters<typeof schemaIssues>[0] | null };

/**
 * Checks what a bound call answered against the model's definition for the component, so a plugin
 * that answers a table with the wrong shape is refused before anything renders it.
 *
 * @remarks
 * Returns `null` for a component that takes no data, and an empty list for a valid answer. Paths
 * are rooted at the answer, as in `items[0].id`.
 *
 * @implNote The precompiled validator writes `.errors` on every call, so they are read before the next call.
 */
export function checkUiData(component: UiComponent, value: unknown): ValidationIssue[] | null {
  if (!BINDABLE.has(component)) {
    return null;
  }
  const validate = (validators as unknown as Record<string, Validator>)[component];
  return validate(value) ? [] : withoutUnchosenChartBranch(component, value, schemaIssues(validate.errors ?? []));
}

/**
 * @implNote A chart answers with series or with a measure, and the schema's `anyOf` reports the
 * required fields of the branch the answer did not choose beside the real fault in the chosen one.
 * The answer's own `series` key picks the branch, as the renderer does.
 */
function withoutUnchosenChartBranch(component: UiComponent, value: unknown, issues: ValidationIssue[]): ValidationIssue[] {
  if (component !== "chart" || typeof value !== "object" || value === null) {
    return issues;
  }
  const unchosen = "series" in value ? ["value", "maximum"] : ["series"];
  const remaining = issues.filter((issue) => !unchosen.includes(issue.path));
  return remaining.length > 0 ? remaining : issues;
}
