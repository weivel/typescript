import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { failedRunExit } from "../../src/program/index.ts";
import { bundleRelocatedProgram } from "../program/child.ts";

interface Probed {
  readonly exit: number | null;
  readonly standardOutput: string;
  readonly standardError: string;
}

/** Runs `source` as a module beside the relocated bundles, in a process of this runtime's own. */
async function probeBesideTheBundles(source: (inProcessFile: string) => string): Promise<Probed> {
  const relocated = await bundleRelocatedProgram();
  try {
    const probe = join(relocated.directory, "probe.mjs");
    writeFileSync(probe, source(`./${basename(relocated.inProcess)}`));
    const ran = spawnSync(process.execPath, [probe], { encoding: "utf8", timeout: 60_000 });
    return { exit: ran.status, standardOutput: ran.stdout.trim(), standardError: ran.stderr.trim() };
  } finally {
    relocated.remove();
  }
}

describe("the in-process bundle", () => {
  it("runs nothing on import, and exports startHost alone", async () => {
    const probed = await probeBesideTheBundles(
      (inProcessFile) =>
        `const imported = await import(${JSON.stringify(inProcessFile)});\n` +
        `console.log(JSON.stringify({ exports: Object.keys(imported), exitCode: process.exitCode ?? null }));\n`,
    );

    expect(probed).toEqual({ exit: 0, standardOutput: JSON.stringify({ exports: ["startHost"], exitCode: null }), standardError: "" });
  });

  it("starts a host that loads the core and the standard beside the bundle", async () => {
    const probed = await probeBesideTheBundles(
      (inProcessFile) =>
        `const { startHost } = await import(${JSON.stringify(inProcessFile)});\n` +
        `const messages = [];\n` +
        `const record = (message) => messages.push(message);\n` +
        `const log = { debug: record, info: record, warn: record, error: record };\n` +
        `const running = await startHost({ hostLibraryPath: "missing-host-library", log });\n` +
        `console.log(JSON.stringify({ code: await running.stop(), messages }));\n`,
    );
    const answered = JSON.parse(probed.standardOutput) as { code: number; messages: string[] };

    expect(probed.exit).toBe(0);
    expect(answered.code).toBe(failedRunExit);
    expect(answered.messages).toEqual([expect.stringMatching(/library\.json could not be read/)]);
  });
});
