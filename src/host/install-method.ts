import { schemaIssues, type ValidationIssue } from "../engine/validation.js";
import * as validators from "./install-method.generated.js";

export type {
  InstallMethodDetectAnswer,
  InstallMethodOperationAnswer,
  InstallMethodOperationRefusal,
  InstallMethodOperationSuccess,
} from "./install-method.generated.js";

export type InstallMethodDefinition = "detectAnswer" | "operationAnswer";

export const INSTALL_METHOD_DEFINITIONS: readonly string[] = validators.INSTALL_METHOD_DEFINITIONS;

type Validator = ((value: unknown) => boolean) & { errors?: Parameters<typeof schemaIssues>[0] | null };

/**
 * Checks what an install method answered against the model's definition for it, so a provider that
 * answers detect without `installed`, or a refusal without a `fix`, is refused before it is acted on.
 *
 * @remarks
 * Returns an empty list for a valid answer. Paths are rooted at the answer, as in `installed`.
 *
 * @implNote The precompiled validator writes `.errors` on every call, so they are read before the next call.
 */
export function checkInstallMethodAnswer(definition: InstallMethodDefinition, value: unknown): ValidationIssue[] {
  const validate = (validators as unknown as Record<string, Validator>)[definition];
  return validate(value) ? [] : schemaIssues(validate.errors ?? []);
}
