import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginContext } from "../../src/context/index.ts";
import { ActivationFailure } from "../../src/host/index.ts";
import { entryOnDisk } from "../../src/standard/index.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function moduleOnDisk(source: string): string {
  const directory = mkdtempSync(join(tmpdir(), "weivel-entry-"));
  directories.push(directory);
  const path = join(directory, "entry.js");
  writeFileSync(path, source);
  return path;
}

const context = {} as PluginContext;

describe("a plugin's code loaded from disk", () => {
  it("is the export its caller names, not the module's default", async () => {
    const path = moduleOnDisk(
      [
        "export const plugin = { activate() { globalThis.weivelEntryRan = 'named'; } };",
        "export default { activate() { globalThis.weivelEntryRan = 'default'; } };",
        "",
      ].join("\n"),
    );

    await entryOnDisk(path, true, "plugin").activate(context);

    expect((globalThis as { weivelEntryRan?: string }).weivelEntryRan).toBe("named");
  });

  it("fails its activation, naming the export, when the module has no such export with an activate", async () => {
    const path = moduleOnDisk("export default { activate() {} };\n");

    const failure = await Promise.resolve(entryOnDisk(path, true, "plugin").activate(context)).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ActivationFailure);
    expect((failure as ActivationFailure).message).toContain('no export "plugin" with an activate function');
  });
});
