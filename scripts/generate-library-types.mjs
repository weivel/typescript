import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "./sibling.mjs";

const USAGE = "usage: node scripts/generate-library-types.mjs <library.json> <out.ts>";

/** The generator is TypeScript, so this reaches it through the build rather than a second copy. */
async function hostEntry() {
  const entry = pathToFileURL(`${repositoryRoot()}/dist/host/index.js`).href;
  try {
    return await import(entry);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    throw new Error(`${entry} is not built; run npm run build first`);
  }
}

async function main([declarationPath, outputPath]) {
  if (!declarationPath || !outputPath) throw new Error(USAGE);
  const { generateLibraryTypes, parseDeclaration } = await hostEntry();
  writeFileSync(outputPath, generateLibraryTypes(parseDeclaration(readFileSync(declarationPath, "utf8"))));
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
