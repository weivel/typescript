import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

const repo = fileURLToPath(new URL("..", import.meta.url));
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

/**
 * @implNote Built under `node_modules` so the compiled engine still resolves `ajv` by walking up,
 * and compiled fresh on every run so the subject can never be a stale `dist`. vitest cannot run
 * under the ban itself: its worker channel dies the moment the flag reaches it.
 */
let outDir: string;

beforeAll(() => {
  const cache = join(repo, "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  outDir = mkdtempSync(join(cache, "eval-ban-"));
  const build = spawnSync(process.execPath, [tsc, "-p", "tsconfig.json", "--outDir", outDir, "--declaration", "false"], { cwd: repo, encoding: "utf8" });
  expect(build.stdout + build.stderr).toBe("");
}, 120_000);

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

function underEvalBan(script: string): { status: number | null; output: string } {
  const run = spawnSync(process.execPath, ["--disallow-code-generation-from-strings", "--input-type=module", "-e", script], { cwd: repo, encoding: "utf8" });
  return { status: run.status, output: run.stdout + run.stderr };
}

it("validates a manifest in a host that bans runtime code generation", () => {
  const engine = pathToFileURL(join(outDir, "engine", "index.js")).href;
  const result = underEvalBan(`
    const { validateManifest } = await import(${JSON.stringify(engine)});
    console.log(JSON.stringify(validateManifest({ id: "Bad Id", api: "one" })));
  `);

  expect(result.status, result.output).toBe(0);
  const issues = JSON.parse(result.output) as Array<{ path: string; fix: string }>;
  expect(issues.map((issue) => issue.path).sort()).toEqual(["api", "id"]);
  expect(issues.find((issue) => issue.path === "id")?.fix).toContain("lowercase words joined by single hyphens");
});
