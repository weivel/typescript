import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot, sibling } from "./sibling.mjs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const kit = sibling("conformance");

if (!existsSync(join(kit, "node_modules"))) {
  const install = spawnSync(npm, ["ci"], { cwd: kit, stdio: "inherit", shell: process.platform === "win32" });
  if (install.status !== 0) process.exit(install.status ?? 1);
}

const driver = `node ${join(repositoryRoot(), "dist", "conformance", "driver.js")}`;
const run = spawnSync(
  npx,
  ["tsx", "runner/src/cli.ts", "run", "--driver", driver, ...process.argv.slice(2)],
  { cwd: kit, stdio: "inherit", shell: process.platform === "win32" },
);
process.exit(run.status ?? 1);
