import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Ajv } from "ajv";
import standaloneCode from "ajv/dist/standalone/index.js";
import { repositoryRoot, sibling } from "./sibling.mjs";

const require = createRequire(import.meta.url);
const GENERATED = [
  { schemaFile: "plugin.schema.json", target: ["src", "engine", "schema.generated.ts"], idName: "MANIFEST_SCHEMA_ID", validatorName: "validateAgainstSchema" },
  { schemaFile: "library.schema.json", target: ["src", "host", "library", "declaration.generated.ts"], idName: "LIBRARY_SCHEMA_ID", validatorName: "validateLibraryDeclaration" },
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

function validatorModule(schema, idName, validatorName) {
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
    "",
  ].join("\n");
}

const MODEL_DEFINITIONS_TARGET = ["src", "host", "library", "model-definitions.generated.ts"];

/**
 * The definitions each model schema publishes, keyed by the file a `$ref` names, so a library type
 * may reference exactly what the model publishes and nothing a hand-kept list claims it does.
 */
function modelDefinitionsModule(schemasByFile) {
  const definitions = Object.fromEntries(
    Object.entries(schemasByFile).map(([schemaFile, schema]) => [schemaFile, Object.keys(schema.definitions ?? {}).sort()]),
  );
  return `export const MODEL_DEFINITIONS: Readonly<Record<string, readonly string[]>> = ${JSON.stringify(definitions)};\n`;
}

function writeGenerated(target, source) {
  const path = join(repositoryRoot(), ...target);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

const schemasByFile = {};
for (const { schemaFile, target, idName, validatorName } of GENERATED) {
  const schema = JSON.parse(readFileSync(join(sibling("model"), schemaFile), "utf8"));
  schemasByFile[schemaFile] = schema;
  writeGenerated(target, validatorModule(schema, idName, validatorName));
}
writeGenerated(MODEL_DEFINITIONS_TARGET, modelDefinitionsModule(schemasByFile));
