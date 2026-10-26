import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Ajv } from "ajv";
import standaloneCode from "ajv/dist/standalone/index.js";
import { repositoryRoot, sibling } from "./sibling.mjs";

const require = createRequire(import.meta.url);
const schema = JSON.parse(readFileSync(join(sibling("model"), "plugin.schema.json"), "utf8"));
const target = join(repositoryRoot(), "src", "engine", "schema.generated.ts");
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

function validatorModule() {
  const ajv = manifestAjv();
  const standalone = inlineRuntimeHelpers(standaloneCode(ajv, ajv.compile(schema))).replace(/^"use strict";/, "");
  const exported = /export const validate = (\w+);export default \1;/.exec(standalone);
  if (!exported) throw new Error("ajv's standalone output no longer exports its validator in the expected shape");
  const body = standalone.replace(exported[0], "");
  if (/new Function|\beval\(/.test(body) || requiresAnything(body)) {
    throw new Error("the precompiled manifest validator still generates or requires code at run time");
  }
  return [
    "// @ts-nocheck",
    `import type { ValidateFunction } from "ajv";`,
    body,
    `export const MANIFEST_SCHEMA_ID: string = ${JSON.stringify(schema.$id)};`,
    `export const validateAgainstSchema: ValidateFunction = ${exported[1]};`,
    "",
  ].join("\n");
}

writeFileSync(target, validatorModule());
