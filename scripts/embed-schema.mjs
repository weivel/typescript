import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { Ajv } from "ajv";
import ts from "typescript";
import standaloneCode from "ajv/dist/standalone/index.js";
import { repositoryRoot, sibling } from "./sibling.mjs";

const require = createRequire(import.meta.url);
const GENERATED = [
  { schemaFile: "plugin.schema.json", target: ["src", "engine", "schema.generated.ts"], idName: "MANIFEST_SCHEMA_ID", validatorName: "validateAgainstSchema" },
  {
    schemaFile: "library.schema.json",
    target: ["src", "host", "library", "declaration.generated.ts"],
    idName: "LIBRARY_SCHEMA_ID",
    validatorName: "validateLibraryDeclaration",
    typeNames: { "": "LibraryDeclaration", services: "LibraryService", "services.functions": "LibraryFunction" },
  },
];
const HELPER_SELF_DESCRIPTION = /\.code = '.*';/g;

/**
 * `verbose` keeps `parentSchema` on each error, where validation reads the failing subschema's
 * `fix`; the keyword is declared so strict mode accepts the schema's own vocabulary.
 */
function manifestAjv() {
  return new Ajv({ strict: true, allErrors: true, verbose: true, code: { source: true, esm: true } })
    .addKeyword({ keyword: "fix", schemaType: "string" });
}

function requiresAnything(source) {
  return /\brequire\(/.test(source.replace(HELPER_SELF_DESCRIPTION, ""));
}

/**
 * ajv's ESM output still calls `require` for its runtime helpers, which no ESM host provides, so
 * each helper's CommonJS source is inlined as a closure. A helper that requires anything further
 * cannot be inlined that way, and stops the build rather than ship a module that fails to load.
 */
function inlineRuntimeHelpers(source) {
  return source.replace(/require\("([^"]+)"\)/g, (_, specifier) => {
    const helper = readFileSync(require.resolve(specifier), "utf8").replace(/^\/\/# sourceMappingURL=.*$/m, "");
    if (requiresAnything(helper)) {
      throw new Error(`ajv runtime helper ${specifier} requires further modules and cannot be inlined`);
    }
    return `((exports) => {${helper}\nreturn exports;})({})`;
  });
}

function documentation(description, indent) {
  return typeof description === "string" ? `${indent}/** ${description} */\n` : "";
}

function unionMember(type) {
  return type.includes(" | ") ? `Array<${type}>` : `${type}[]`;
}

/**
 * The TypeScript type a schema node describes, declaring each object with properties as the
 * interface `scope.names` names for its path, so the declaration's types are read from the schema
 * rather than kept beside it by hand. A `$ref` to a definition is read at the path `#<definition>`,
 * or is the type `scope.external` maps it to.
 */
function schemaType(schema, path, scope) {
  if (typeof schema.$ref === "string") return referencedType(schema.$ref, scope);
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map((arm) => schemaType(arm, path, scope)).join(" | ");
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (schema.type === "string") return "string";
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "null") return "null";
  if (schema.type === "array") return unionMember(schemaType(schema.items, path, scope));
  if (schema.type === "object" && typeof schema.additionalProperties === "object") {
    return `Record<string, ${schemaType(schema.additionalProperties, path, scope)}>`;
  }
  if (schema.type === "object" && schema.properties === undefined) return "object";
  if (schema.type === "object" || schema.properties !== undefined) return interfaceType(schema, path, scope);
  throw new Error(`cannot type the schema at ${path || "its root"}: ${JSON.stringify(schema)}`);
}

function referencedType(reference, scope) {
  const name = reference.replace("#/definitions/", "");
  const target = scope.definitions?.[name];
  if (target === undefined) throw new Error(`cannot resolve ${reference}`);
  return scope.external?.[name] ?? schemaType(target, `#${name}`, scope);
}

function interfaceType(schema, path, scope) {
  const name = scope.names[path];
  if (name === undefined) throw new Error(`the schema declares an object at ${path || "its root"} that no type name is given for`);
  if (scope.interfaces.has(name)) return name;
  scope.interfaces.set(name, "");
  const required = new Set(schema.required ?? []);
  const members = Object.entries(schema.properties).map(([key, property]) => {
    const type = schemaType(property, path ? `${path}.${key}` : key, scope);
    return `${documentation(property.description, "  ")}  ${JSON.stringify(key)}${required.has(key) ? "" : "?"}: ${type};`;
  });
  scope.interfaces.set(name, `${documentation(schema.description, "")}export interface ${name} {\n${members.join("\n")}\n}`);
  return name;
}

function typesSource(schema, scope) {
  const typeScope = { ...scope, interfaces: new Map() };
  schemaType(schema, "", typeScope);
  return [...typeScope.interfaces.values()].reverse().join("\n\n");
}

function validatorModule(schema, idName, validatorName, typeNames) {
  const ajv = manifestAjv();
  const standalone = inlineRuntimeHelpers(standaloneCode(ajv, ajv.compile(schema))).replace(/^"use strict";/, "");
  const exported = /export const validate = (\w+);export default \1;/.exec(standalone);
  if (!exported) throw new Error("ajv's standalone output no longer exports its validator in the expected shape");
  const body = standalone.replace(exported[0], "");
  if (/new Function|\beval\(/.test(body) || requiresAnything(body)) {
    throw new Error(`the precompiled ${idName} validator still generates or requires code at run time`);
  }
  return [
    "// @ts-nocheck",
    `import type { ValidateFunction } from "ajv";`,
    body,
    `export const ${idName}: string = ${JSON.stringify(schema.$id)};`,
    `export const ${validatorName}: ValidateFunction = ${exported[1]};`,
    ...(typeNames ? [typesSource(schema, { names: typeNames })] : []),
    "",
  ].join("\n");
}

const MODEL_DEFINITIONS_TARGET = ["src", "host", "library", "model-definitions.generated.ts"];

function isDeclaredIn(directory, symbol) {
  return (symbol.declarations ?? []).some((declaration) => !relative(directory, declaration.getSourceFile().fileName).startsWith(".."));
}

/**
 * Every type the public entry exports from `src/contract`, by name.
 *
 * @implNote A model definition names a contract type only by its spelling, and types are erased at
 * run time, so the generator learns which of them the contract really declares from this list,
 * the way the Java generator asks its class loader for the contract package and nothing else.
 */
function contractTypeNames() {
  const entry = join(repositoryRoot(), "src", "index.ts");
  const contractDirectory = join(repositoryRoot(), "src", "contract");
  const program = ts.createProgram([entry], { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, noEmit: true, skipLibCheck: true, types: [] });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  const module = source && checker.getSymbolAtLocation(source);
  if (!module) throw new Error(`cannot read the contract's exports from ${entry}`);
  return checker
    .getExportsOfModule(module)
    .map((exported) => (exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported))
    .filter((symbol) => symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias))
    .filter((symbol) => isDeclaredIn(contractDirectory, symbol))
    .map((symbol) => symbol.name)
    .sort();
}

/**
 * The definitions each model schema publishes, keyed by the file a `$ref` names, so a library type
 * may reference exactly what the model publishes and nothing a hand-kept list claims it does, and
 * the contract's type names, so a definition without a contract type is refused rather than imported.
 */
function modelDefinitionsModule(schemasByFile, contractTypes) {
  const definitions = Object.fromEntries(
    Object.entries(schemasByFile).map(([schemaFile, schema]) => [schemaFile, Object.keys(schema.definitions ?? {}).sort()]),
  );
  return [
    `export const MODEL_DEFINITIONS: Readonly<Record<string, readonly string[]>> = ${JSON.stringify(definitions)};`,
    `export const CONTRACT_TYPES: readonly string[] = ${JSON.stringify(contractTypes)};`,
    "",
  ].join("\n");
}

const UI_DATA_TYPE_NAMES = {
  "#item": "UiItem",
  "#column": "UiColumn",
  "#entry": "UiEntry",
  "#series": "UiSeries",
  "#itemsAnswer": "UiItems",
  "#textAnswer": "UiTextAnswer",
  "#entriesAnswer": "UiEntriesAnswer",
  "#measureAnswer": "UiMeasureAnswer",
  "#chartAnswer": "UiSeriesAnswer",
  "#badgeAnswer": "UiBadgeAnswer",
};

/**
 * The answer types of `ui-data.schema.json`: one interface per answer definition, `UiItemState`
 * from the item's state enum, and `UiData` as the union of what every bindable component answers.
 *
 * @implNote The tone definition maps to the contract's `UiTone` rather than a second union, so a
 * tone the contract adds cannot be missing from an answer type.
 */
function uiDataTypesSource(schema) {
  const scope = { names: UI_DATA_TYPE_NAMES, definitions: schema.definitions, external: { tone: "UiTone" }, interfaces: new Map() };
  const components = Object.keys(schema.definitions).filter((name) => schema.definitions[name].$ref !== undefined);
  const answerTypes = components.map((component) => schemaType(schema.definitions[component], `#${component}`, scope));
  const answers = [...new Set(answerTypes.flatMap((type) => type.split(" | ")))];
  const state = schemaType(schema.definitions.item.properties.state, "#item.state", scope);
  return [...scope.interfaces.values(), `export type UiItemState = ${state};`, `export type UiData = ${answers.join(" | ")};`].join("\n\n");
}

const UI_DATA_TARGET = ["src", "host", "ui-data.generated.ts"];

/**
 * One precompiled validator per definition the schema publishes, exported by definition name, so
 * the host picks the validator for a component by the component's own name.
 */
function definitionValidatorsModule(schema) {
  const ajv = manifestAjv();
  ajv.addSchema(schema);
  const names = Object.keys(schema.definitions);
  const references = Object.fromEntries(names.map((name) => [name, `${schema.$id}#/definitions/${name}`]));
  const standalone = inlineRuntimeHelpers(standaloneCode(ajv, references)).replace(/^"use strict";/, "");
  if (/new Function|\beval\(/.test(standalone) || requiresAnything(standalone)) {
    throw new Error("the precompiled ui-data validators still generate or require code at run time");
  }
  return [
    "// @ts-nocheck",
    `import type { UiTone } from "../index.js";`,
    standalone,
    `export const UI_DATA_DEFINITIONS: readonly string[] = ${JSON.stringify(names)};`,
    uiDataTypesSource(schema),
    "",
  ].join("\n");
}

function writeGenerated(target, source) {
  const path = join(repositoryRoot(), ...target);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

const schemasByFile = {};
for (const { schemaFile, target, idName, validatorName, typeNames } of GENERATED) {
  const schema = JSON.parse(readFileSync(join(sibling("model"), schemaFile), "utf8"));
  schemasByFile[schemaFile] = schema;
  writeGenerated(target, validatorModule(schema, idName, validatorName, typeNames));
}
writeGenerated(MODEL_DEFINITIONS_TARGET, modelDefinitionsModule(schemasByFile, contractTypeNames()));
writeGenerated(UI_DATA_TARGET, definitionValidatorsModule(JSON.parse(readFileSync(join(sibling("model"), "ui-data.schema.json"), "utf8"))));
