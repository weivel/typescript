import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repo = fileURLToPath(new URL("..", import.meta.url));
const NODE_BUILTINS = ["fs", "path", "os", "process", "child_process", "url", "crypto", "util", "events", "stream"];
const NODE_FREE_ENTRIES = ["src/index.ts", "src/engine/index.ts"];

function specifiers(source: string): string[] {
  return [...source.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((match) => match[1]);
}

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || NODE_BUILTINS.includes(specifier);
}

function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, `${base}.js`];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Every node builtin the module graph rooted at `entry` reaches, not just the ones it names itself.
 *
 * @remarks
 * A per-file check passes the moment the builtin moves one relative import away, so the walk
 * follows relative specifiers and reports whatever the whole graph reaches.
 */
function nodeImportsFrom(entry: string): string[] {
  const found = new Set<string>();
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const specifier of specifiers(source)) {
      if (specifier.startsWith(".")) {
        const next = resolveRelative(file, specifier);
        if (next) queue.push(next);
        continue;
      }
      if (isNodeBuiltin(specifier)) found.add(specifier);
    }
  }
  return [...found].sort();
}

it("reaches no node builtin from the contract or the engine entry", () => {
  const offenders = NODE_FREE_ENTRIES
    .map((entry) => ({ entry, imports: nodeImportsFrom(join(repo, entry)) }))
    .filter((result) => result.imports.length > 0);
  expect(offenders).toEqual([]);
});

it("is a graph walk, so a builtin one relative import away is still caught", () => {
  const directory = mkdtempSync(join(tmpdir(), "engine-node-free-"));
  writeFileSync(join(directory, "entry.ts"), `export * from "./deep.js";\n`);
  writeFileSync(join(directory, "deep.ts"), `import { readFileSync } from "node:fs";\nexport const read = readFileSync;\n`);

  const entrySource = readFileSync(join(directory, "entry.ts"), "utf8");
  expect(specifiers(entrySource).filter(isNodeBuiltin)).toEqual([]);
  expect(nodeImportsFrom(join(directory, "entry.ts"))).toEqual(["node:fs"]);
});
