import type { ValidationIssue } from "../../engine/validation.js";
import { checkInstallMethodAnswer, INSTALL_METHOD_DEFINITIONS, type InstallMethodDefinition } from "../../host/install-method.js";
import { checkUiData } from "../../host/ui-data.js";
import type { UiComponent } from "../../index.js";
import type { Operation } from "../operation.js";

const UI_DATA_SCHEMA = "https://weivel.github.io/model/ui-data.schema.json";
const INSTALL_METHOD_SCHEMA = "https://weivel.github.io/model/install-method.schema.json";

function issuesOf(schema: unknown, definition: string, value: unknown): ValidationIssue[] {
  if (schema === UI_DATA_SCHEMA) {
    const issues = checkUiData(definition as UiComponent, value);
    if (issues === null) throw new Error(`${definition} is not a definition of ${schema}`);
    return issues;
  }
  if (schema === INSTALL_METHOD_SCHEMA && INSTALL_METHOD_DEFINITIONS.includes(definition)) {
    return checkInstallMethodAnswer(definition as InstallMethodDefinition, value);
  }
  throw new Error(`no schema ${String(schema)} with definition ${definition}`);
}

export const answer: Operation = (given) => {
  const issues = issuesOf(given.schema, String(given.definition), given.value);
  return { valid: issues.length === 0, paths: issues.map((issue) => issue.path) };
};
