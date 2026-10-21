import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repo = fileURLToPath(new URL("../..", import.meta.url));

function runWithoutCodeGeneration(script: string): string {
  return execFileSync(process.execPath, ["--disallow-code-generation-from-strings", "--input-type=module", "-e", script], {
    cwd: repo,
    encoding: "utf8",
  });
}

it("loads and orders in a host that forbids runtime code generation", () => {
  execFileSync(process.execPath, ["node_modules/typescript/bin/tsc"], { cwd: repo });
  const output = runWithoutCodeGeneration(`
    const engine = await import("./dist/engine/index.js");
    engine.order([], "service");
    engine.createHost({ app: "x" });
    console.log("loaded");
  `);
  expect(output.trim()).toBe("loaded");
}, 120_000);
