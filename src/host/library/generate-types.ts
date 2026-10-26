import { pluginError } from "../../engine/index.js";
import type { LibraryDeclaration, LibraryFunction, LibraryService } from "./declaration.js";
import { MODEL_DEFINITIONS } from "./model-definitions.generated.js";

const PUBLIC_ENTRY = "@weivel/typescript";
const MODEL_DEFINITION = /^https:\/\/weivel\.github\.io\/model\/([^#/]+)#\/definitions\/([^/]+)$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const PRIMITIVE_TYPES: Readonly<Record<string, string>> = { string: "string", integer: "number", number: "number", boolean: "boolean" };
const STRUCTURAL_KEYWORDS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "$ref"]);
const OBJECT_KEYWORDS = ["properties", "required", "additionalProperties"];

/**
 * Keywords that annotate a schema or constrain a value without changing its TypeScript type.
 *
 * @implNote The Java generator ignores the same list; any other keyword is refused, so a form neither
 * generator understands can never be silently widened to a looser type.
 */
const TYPE_NEUTRAL_KEYWORDS = new Set([
  "title", "description", "$comment", "default", "examples", "readOnly", "writeOnly", "fix",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "pattern", "format",
  "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties",
]);

type Schema = Record<string, unknown>;

interface Generation {
  readonly libraryId: string;
  readonly imports: Set<string>;
}

function refuse(generation: Generation, path: string, reason: string, fix: string): never {
  throw pluginError(generation.libraryId, `cannot generate types: ${path} ${reason}`, fix);
}

function isSchema(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `app-registry` becomes `AppRegistry` and `appDescriptor` becomes `AppDescriptor`. */
function pascalCase(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function propertyKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function refuseUnsupportedKeywords(schema: Schema, path: string, generation: Generation): void {
  const unsupported = Object.keys(schema).find((keyword) => !STRUCTURAL_KEYWORDS.has(keyword) && !TYPE_NEUTRAL_KEYWORDS.has(keyword));
  if (unsupported !== undefined) {
    refuse(generation, `${path}.${unsupported}`, "is not a schema form the generator supports", "use object, array, string, integer, number, boolean, enum, a $ref to a model definition, or {}");
  }
}

function refuseMisplacedKeywords(schema: Schema, path: string, generation: Generation): void {
  const misplacedObjectKeyword = schema.type === "object" ? undefined : OBJECT_KEYWORDS.find((keyword) => keyword in schema);
  if (misplacedObjectKeyword !== undefined) {
    refuse(generation, `${path}.${misplacedObjectKeyword}`, "applies only beside \"type\": \"object\"", "declare the schema's type as object");
  }
  if (schema.type !== "array" && "items" in schema) {
    refuse(generation, `${path}.items`, "applies only beside \"type\": \"array\"", "declare the schema's type as array");
  }
}

function referenceType(schema: Schema, path: string, generation: Generation): string {
  const sibling = Object.keys(schema).find((keyword) => keyword !== "$ref" && STRUCTURAL_KEYWORDS.has(keyword));
  if (sibling !== undefined) refuse(generation, `${path}.${sibling}`, "sits beside a $ref, which ignores it", "remove it, or drop the $ref");
  const reference = schema.$ref;
  const [, file, definition] = (typeof reference === "string" ? MODEL_DEFINITION.exec(reference) : null) ?? [];
  if (file === undefined || definition === undefined) {
    refuse(generation, `${path}.$ref`, `is ${JSON.stringify(reference)}, which does not name a weivel/model definition`, "reference https://weivel.github.io/model/<file>#/definitions/<name>, or declare the shape inline");
  }
  if (!(Object.hasOwn(MODEL_DEFINITIONS, file) && MODEL_DEFINITIONS[file].includes(definition))) {
    refuse(generation, `${path}.$ref`, `names ${definition} in ${file}, which weivel/model does not publish`, "reference a definition the model publishes, or declare the shape inline");
  }
  const contractType = pascalCase(definition);
  generation.imports.add(contractType);
  return contractType;
}

function isEnumValue(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function enumType(schema: Schema, path: string, generation: Generation): string {
  const values = schema.enum;
  if (!Array.isArray(values) || values.length === 0 || !values.every(isEnumValue)) {
    refuse(generation, `${path}.enum`, "is not a non-empty list of strings, numbers, booleans or null", "list the allowed primitive values");
  }
  return [...new Set(values.map((value) => JSON.stringify(value)))].join(" | ");
}

function requiredNames(schema: Schema, path: string, generation: Generation): ReadonlySet<string> {
  const required = schema.required ?? [];
  if (!Array.isArray(required) || !required.every((name) => typeof name === "string")) {
    refuse(generation, `${path}.required`, "is not a list of property names", "list the required property names as strings");
  }
  return new Set(required);
}

function objectType(schema: Schema, path: string, generation: Generation): string {
  const additional = schema.additionalProperties;
  if (additional !== undefined && typeof additional !== "boolean") {
    refuse(generation, `${path}.additionalProperties`, "is a schema, which the generator does not support", "set additionalProperties to true or false, or remove it");
  }
  const properties = schema.properties ?? {};
  if (!isSchema(properties)) refuse(generation, `${path}.properties`, "is not an object of schemas", "map each property name to its schema");
  const required = requiredNames(schema, path, generation);
  const members = Object.entries(properties).map(([name, property]) => {
    const optional = required.has(name) ? "" : "?";
    return `${propertyKey(name)}${optional}: ${typeOf(property, `${path}.properties.${name}`, generation)}`;
  });
  const undeclaredRequired = [...required].filter((name) => !Object.hasOwn(properties, name));
  members.push(...undeclaredRequired.map((name) => `${propertyKey(name)}: unknown`));
  if (additional !== false) members.push("[key: string]: unknown");
  return members.length === 0 ? "{ [key: string]: never }" : `{ ${members.join("; ")} }`;
}

function arrayType(schema: Schema, path: string, generation: Generation): string {
  if (!isSchema(schema.items) && typeof schema.items !== "boolean") refuse(generation, `${path}.items`, "is not one schema for every element", "give the array a single items schema");
  const element = typeOf(schema.items, `${path}.items`, generation);
  return element.includes("|") ? `(${element})[]` : `${element}[]`;
}

function declaredType(schema: Schema, path: string, generation: Generation): string {
  const type = schema.type;
  if (type === undefined) return "unknown";
  if (type === "object") return objectType(schema, path, generation);
  if (type === "array") return arrayType(schema, path, generation);
  if (typeof type === "string" && Object.hasOwn(PRIMITIVE_TYPES, type)) return PRIMITIVE_TYPES[type];
  return refuse(generation, `${path}.type`, `is ${JSON.stringify(type)}, which the generator does not support`, "use one of object, array, string, integer, number or boolean");
}

function typeOf(schema: unknown, path: string, generation: Generation): string {
  if (schema === true) return "unknown";
  if (schema === false) return "never";
  if (!isSchema(schema)) refuse(generation, path, "is not a schema object", "write the schema as an object; {} accepts anything");
  refuseUnsupportedKeywords(schema, path, generation);
  if ("$ref" in schema) return referenceType(schema, path, generation);
  refuseMisplacedKeywords(schema, path, generation);
  if ("enum" in schema) return enumType(schema, path, generation);
  return declaredType(schema, path, generation);
}

function methodSource(fn: LibraryFunction, path: string, generation: Generation): string {
  const argument = typeOf(fn.argument, `${path}.argument`, generation);
  const result = typeOf(fn.result, `${path}.result`, generation);
  return `  ${fn.name}(argument: ${argument}): ${result};`;
}

function refuseDuplicateFunctions(service: LibraryService, path: string, generation: Generation): void {
  const seen = new Set<string>();
  service.functions.forEach((fn, index) => {
    if (seen.has(fn.name)) refuse(generation, `${path}.functions[${index}].name`, `repeats the function ${fn.name}`, "give every function of a service its own name");
    seen.add(fn.name);
  });
}

function serviceSource(service: LibraryService, index: number, generation: Generation): string {
  const path = `services[${index}]`;
  refuseDuplicateFunctions(service, path, generation);
  const name = pascalCase(service.id);
  if (!/^[A-Za-z]/.test(name)) {
    refuse(generation, `${path}.id`, `is ${JSON.stringify(service.id)}, which yields ${JSON.stringify(name)}, not a TypeScript identifier`, "start the service id with a letter");
  }
  const methods = service.functions.map((fn, fnIndex) => methodSource(fn, `${path}.functions[${fnIndex}]`, generation));
  return [
    `export interface ${name}Service {`,
    ...methods,
    "}",
    "",
    `export const ${name}: ServiceType<${name}Service> = { id: ${JSON.stringify(service.id)} };`,
  ].join("\n");
}

function refuseCollidingNames(declaration: LibraryDeclaration, generation: Generation): void {
  const taken = new Set(generation.imports);
  declaration.services.forEach((service, index) => {
    const name = pascalCase(service.id);
    for (const declared of [name, `${name}Service`]) {
      if (taken.has(declared)) {
        refuse(generation, `services[${index}].id`, `generates the name ${declared}, which is already taken in the generated module`, "give the service an id that does not collide");
      }
      taken.add(declared);
    }
  });
}

/** The header interpolates the id and version, and a line terminator in either would end its comment. */
function refuseHeaderBreakout(declaration: LibraryDeclaration, generation: Generation): void {
  for (const field of ["id", "version"] as const) {
    if (CONTROL_CHARACTER.test(declaration[field])) {
      refuse(generation, field, `is ${JSON.stringify(declaration[field])}, which carries a control character`, `remove control characters from the declaration's ${field}`);
    }
  }
}

/**
 * The TypeScript a plugin author compiles against for a library's services: one interface and one
 * typed key per service, importing contract types from the package's public entry.
 *
 * @remarks
 * Types only. The calls are assembled at run time by `servicesOf`, so nothing generated here
 * ever executes beyond the keys.
 */
export function generateLibraryTypes(declaration: LibraryDeclaration): string {
  const generation: Generation = { libraryId: declaration.id, imports: new Set(["ServiceType"]) };
  refuseHeaderBreakout(declaration, generation);
  const services = declaration.services.map((service, index) => serviceSource(service, index, generation));
  refuseCollidingNames(declaration, generation);
  return [
    `// Generated from the library.json of ${declaration.id} ${declaration.version}; regenerate it from the declaration rather than editing it.`,
    `import type { ${[...generation.imports].sort().join(", ")} } from "${PUBLIC_ENTRY}";`,
    "",
    services.join("\n\n"),
    "",
  ].join("\n");
}
