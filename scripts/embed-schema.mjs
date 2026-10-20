import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot, sibling } from "./sibling.mjs";

const schema = JSON.parse(readFileSync(join(sibling("model"), "plugin.schema.json"), "utf8"));
const target = join(repositoryRoot(), "src", "engine", "schema.generated.ts");
const source = `export const MANIFEST_SCHEMA: Readonly<Record<string, unknown>> = ${JSON.stringify(schema, null, 2)};\n`;
writeFileSync(target, source);
