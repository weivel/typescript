import { Ajv } from "ajv";
import type { ErrorObject } from "ajv";
import type { PluginManifest } from "../index.js";
import { pluginError } from "./errors.js";
import { MANIFEST_SCHEMA } from "./schema.generated.js";

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
  readonly fix: string;
}

type ServiceSide = "provides" | "consumes";

const SERVICE_SIDES: readonly ServiceSide[] = ["provides", "consumes"];

/**
 * @implNote Compiled once at load. The compiled function holds no per-call state, so this is not
 * the mutable host state design 7.11 forbids. `fix` is the schema's own keyword, declared so strict
 * mode accepts it and so the failing subschema can hand its fix to the author.
 */
const validateSchema = new Ajv({ strict: true, allErrors: true, verbose: true })
  .addKeyword({ keyword: "fix", schemaType: "string" })
  .compile(MANIFEST_SCHEMA);

/**
 * Checks a manifest against the published schema, then against `VALIDATION.md` V1 and V2.
 *
 * @remarks
 * V1 and V2 run only when the schema passes: once a field has the wrong type there is nothing
 * trustworthy left to cross-check. `wellKnownServices` undefined skips V2, and an empty list refuses
 * every bare id.
 */
export function validateManifest(manifest: unknown, wellKnownServices?: readonly string[]): ValidationIssue[] {
  if (!validateSchema(manifest)) {
    return firstPerPath(withoutAlternativeNoise(validateSchema.errors ?? []).flatMap(issueOf));
  }
  return firstPerPath([...bareServiceIssues(manifest, wellKnownServices), ...duplicateServiceIssues(manifest)]);
}

/** Returns the manifest itself, or throws a refusal attributed to its id carrying the first issue's fix. */
export function assertManifest(manifest: unknown, wellKnownServices?: readonly string[]): PluginManifest {
  const issues = validateManifest(manifest, wellKnownServices);
  const [first] = issues;
  if (first === undefined) {
    return manifest as PluginManifest;
  }
  const detail = issues.map((issue) => issue.message).join("; ");
  throw pluginError(declaredId(manifest), `plugin.json: ${detail}`, first.fix);
}

function declaredId(manifest: unknown): string {
  const id = recordOf(manifest)?.id;
  return typeof id === "string" ? id : "manifest";
}

/**
 * @implNote An `anyOf` reports its own failure beside the errors of every branch. A branch whose
 * `type` check failed at the same instance never applied to it, so its errors are noise. When no
 * branch applies, the `anyOf` error itself is the one to report, carrying the items-level `fix`;
 * when one does, that branch's own errors name the field that is wrong.
 */
function withoutAlternativeNoise(errors: ErrorObject[]): ErrorObject[] {
  const alternatives = errors.filter((error) => error.keyword === "anyOf");
  const droppedBranches = alternatives.flatMap((alternative) =>
    inapplicableBranchPrefixes(alternative, errors).map((prefix) => ({ alternative, prefix })),
  );
  return errors.filter((error) => {
    const droppedAsBranch = droppedBranches.some(
      ({ alternative, prefix }) => error.schemaPath.startsWith(prefix) && isWithin(error.instancePath, alternative.instancePath),
    );
    const droppedAsAlternative = alternatives.includes(error) && hasApplicableBranch(error, errors);
    return !droppedAsBranch && !droppedAsAlternative;
  });
}

function branchCountOf(alternative: ErrorObject): number {
  return Array.isArray(alternative.schema) ? alternative.schema.length : 0;
}

function inapplicableBranchPrefixes(alternative: ErrorObject, errors: ErrorObject[]): string[] {
  const prefixes = Array.from({ length: branchCountOf(alternative) }, (_, branch) => `${alternative.schemaPath}/${branch}/`);
  return prefixes.filter((prefix) => !isApplicable(prefix, alternative, errors));
}

function hasApplicableBranch(alternative: ErrorObject, errors: ErrorObject[]): boolean {
  const prefixes = Array.from({ length: branchCountOf(alternative) }, (_, branch) => `${alternative.schemaPath}/${branch}/`);
  return prefixes.some((prefix) => isApplicable(prefix, alternative, errors));
}

function isApplicable(prefix: string, alternative: ErrorObject, errors: ErrorObject[]): boolean {
  return !errors.some(
    (error) => error.schemaPath === `${prefix}type` && error.instancePath === alternative.instancePath,
  );
}

function isWithin(instancePath: string, ancestorPath: string): boolean {
  return instancePath === ancestorPath || instancePath.startsWith(`${ancestorPath}/`);
}

function issueOf(error: ErrorObject): ValidationIssue[] {
  if (error.keyword === "if") {
    return [];
  }
  if (error.keyword === "uniqueItems") {
    return repeatedIndexes(error.data).map((index) => issueAt(`${dottedPath(error.instancePath)}[${index}]`, error));
  }
  return [issueAt(pathOf(error), error)];
}

function issueAt(path: string, error: ErrorObject): ValidationIssue {
  return { path, message: `${path}: ${error.message ?? "is invalid"}`, fix: fixOf(error) };
}

function repeatedIndexes(items: unknown): number[] {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.flatMap((item, index) => (items.slice(0, index).some((earlier) => sameJson(earlier, item)) ? [index] : []));
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightRecord = right as Record<string, unknown>;
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => key in rightRecord && sameJson((left as Record<string, unknown>)[key], rightRecord[key]))
  );
}

function missingPropertyOf(error: ErrorObject): string {
  return String((error.params as { missingProperty: string }).missingProperty);
}

function pathOf(error: ErrorObject): string {
  const base = dottedPath(error.instancePath);
  if (error.keyword === "required") {
    const missing = missingPropertyOf(error);
    return base === "" ? missing : `${base}.${missing}`;
  }
  return base === "" ? "(root)" : base;
}

function dottedPath(instancePath: string): string {
  const segments = instancePath.split("/").slice(1).map(unescapePointer);
  return segments.reduce((path, segment) => {
    if (/^\d+$/.test(segment)) {
      return `${path}[${segment}]`;
    }
    return path === "" ? segment : `${path}.${segment}`;
  }, "");
}

function unescapePointer(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function fixOf(error: ErrorObject): string {
  const parent = recordOf(error.parentSchema);
  const declared =
    error.keyword === "required"
      ? recordOf(recordOf(parent?.properties)?.[missingPropertyOf(error)])?.fix
      : parent?.fix;
  if (typeof declared === "string") {
    return declared;
  }
  return `correct the value so that it ${error.message ?? "satisfies the schema"}`;
}

function firstPerPath(issues: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    if (seen.has(issue.path)) {
      return false;
    }
    seen.add(issue.path);
    return true;
  });
}

function bareServiceIssues(manifest: unknown, wellKnownServices: readonly string[] | undefined): ValidationIssue[] {
  if (wellKnownServices === undefined) {
    return [];
  }
  const pluginId = declaredId(manifest);
  return serviceIds(manifest, "provides").flatMap((serviceId, index) => {
    if (mayRegister(pluginId, serviceId, wellKnownServices)) {
      return [];
    }
    const path = `services.provides[${index}]`;
    return [
      {
        path,
        message: `${path}: "${serviceId}" is neither namespaced by this plugin nor a well-known service id`,
        fix: `rename it to "${pluginId}:<name>", or use one of: ${wellKnownServices.join(", ")}`,
      },
    ];
  });
}

function mayRegister(pluginId: string, serviceId: string, wellKnownServices: readonly string[]): boolean {
  if (wellKnownServices.includes(serviceId)) {
    return true;
  }
  const separator = serviceId.indexOf(":");
  return separator > 0 && separator < serviceId.length - 1 && serviceId.slice(0, separator) === pluginId;
}

function duplicateServiceIssues(manifest: unknown): ValidationIssue[] {
  return SERVICE_SIDES.flatMap((side) => {
    const seen = new Set<string>();
    return serviceIds(manifest, side).flatMap((serviceId, index) => {
      if (!seen.has(serviceId)) {
        seen.add(serviceId);
        return [];
      }
      const path = `services.${side}[${index}]`;
      return [{ path, message: `${path}: "${serviceId}" is listed twice`, fix: "remove the duplicate entry" }];
    });
  });
}

/** @implNote The string form and the object form name the same service, so both read as their id. */
function serviceIds(manifest: unknown, side: ServiceSide): string[] {
  const entries = recordOf(recordOf(manifest)?.services)?.[side];
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.map((entry) => (typeof entry === "string" ? entry : String(recordOf(entry)?.id)));
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
