import { pluginError } from "../../engine/index.js";
import type { LibraryDeclaration, LibraryFunction, LibraryService } from "./declaration.js";

/**
 * Every type the package's public entry exports, which is what a model `$ref` may map onto.
 *
 * @implNote Held exactly equal to the entry's type exports by its test, so a type added to the
 * contract fails the suite until it is listed here; the generator ships without the compiler, so it
 * cannot ask the entry itself.
 */
export const CONTRACT_TYPE_NAMES: ReadonlySet<string> = new Set([
  "AppDescriptor", "AppDetect", "AppDiscovery", "AppHome", "AppLoader", "AppModelCatalog", "AppNpmPlugins",
  "AppPathNames", "AppProjects", "AppStartupHook", "AppUsage", "CapabilityType", "Events", "HomeDescriptor",
  "HostDescriptor", "Logger", "ManifestCommand", "ManifestConfig", "ManifestData", "ManifestLifecycle",
  "ManifestMarketplace", "ManifestOffer", "ManifestPublish", "ManifestRequirement", "ManifestServices",
  "MarketplaceCategory", "MarketplaceMatch", "Plugin", "PluginConfig", "PluginContext", "PluginError",
  "PluginManifest", "PluginPaths", "RepoMeta", "Scheduler", "ServiceType", "Services", "Store", "TopicType",
  "WantOptions",
]);

const PUBLIC_ENTRY = "@weivel/typescript";
const MODEL_DEFINITION = /^https:\/\/weivel\.github\.io\/model\/[^#/]+#\/definitions\/([A-Za-z][A-Za-z0-9]*)$/;
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
  const definition = typeof reference === "string" ? MODEL_DEFINITION.exec(reference)?.[1] : undefined;
  if (definition === undefined) {
    refuse(generation, `${path}.$ref`, `is ${JSON.stringify(reference)}, which is not a definition weivel/model publishes`, "reference https://weivel.github.io/model/<file>#/definitions/<name>, or declare the shape inline");
  }
  const contractType = pascalCase(definition);
  if (!CONTRACT_TYPE_NAMES.has(contractType)) {
    refuse(generation, `${path}.$ref`, `names the model definition ${definition}, but the contract exports no type ${contractType}`, `add ${contractType} to the contract, or reference a definition it exports`);
  }
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
  if (additional !== undefined && additional !== false) {
    refuse(generation, `${path}.additionalProperties`, "is neither false nor absent", "set additionalProperties to false, or remove it to allow any further property");
  }
  const properties = schema.properties ?? {};
  if (!isSchema(properties)) refuse(generation, `${path}.properties`, "is not an object of schemas", "map each property name to its schema");
  const required = requiredNames(schema, path, generation);
  const members = Object.entries(properties).map(([name, property]) => {
    const optional = required.has(name) ? "" : "?";
    return `${propertyKey(name)}${optional}: ${typeOf(property, `${path}.properties.${name}`, generation)}`;
  });
  if (additional === undefined) members.push("[key: string]: unknown");
  return members.length === 0 ? "{ [key: string]: never }" : `{ ${members.join("; ")} }`;
}

function arrayType(schema: Schema, path: string, generation: Generation): string {
  if (!isSchema(schema.items)) refuse(generation, `${path}.items`, "is not one schema for every element", "give the array a single items schema");
  const element = typeOf(schema.items, `${path}.items`, generation);
  return element.includes("|") ? `(${element})[]` : `${element}[]`;
}

function declaredType(schema: Schema, path: string, generation: Generation): string {
  const type = schema.type;
  if (type === undefined) return "unknown";
  if (type === "object") return objectType(schema, path, generation);
  if (type === "array") return arrayType(schema, path, generation);
  if (typeof type === "string" && type in PRIMITIVE_TYPES) return PRIMITIVE_TYPES[type];
  return refuse(generation, `${path}.type`, `is ${JSON.stringify(type)}, which the generator does not support`, "use one of object, array, string, integer, number or boolean");
}

function typeOf(schema: unknown, path: string, generation: Generation): string {
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
