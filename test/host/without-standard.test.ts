import koffi from "koffi";
import { afterEach, describe, expect, it } from "vitest";
import { EdgeSource, sharedLibraryFileName } from "../../src/core/index.ts";
import { Host } from "../../src/host/index.ts";
import { coreLibraryPath } from "../real-core.ts";
import { activated, alive } from "./world.ts";

const loadedPaths: string[] = [];
const load = koffi.load;

afterEach(() => {
  koffi.load = load;
});

/** Records the path of every native library loaded from now on, in this file's own module graph. */
function recordLoads(): void {
  koffi.load = ((path: string, ...rest: unknown[]) => {
    loadedPaths.push(path);
    return (load as (...parameters: unknown[]) => koffi.IKoffiLib)(path, ...rest);
  }) as typeof koffi.load;
}

describe("a host created without the standard", () => {
  it("registers, activates and destroys a plugin its caller hands in, never loading the standard", async () => {
    recordLoads();
    const activatedNames: string[] = [];
    const host = Host.create({ edgeSource: EdgeSource.Capabilities, coreLibraryPath });

    const answer = alive(host.register({ importName: "inline", api: 1 }, { activate: (context) => void activatedNames.push(context.manifest.importName) }));
    const report = await activated(host, [answer.plugin!]);
    await host.destroy();

    expect(report.outcomes.map((outcome) => outcome.state)).toEqual(["active"]);
    expect(activatedNames).toEqual(["inline"]);
    expect(loadedPaths).toEqual([coreLibraryPath]);
    expect(loadedPaths.some((path) => path.endsWith(sharedLibraryFileName("weivel_standard")))).toBe(false);
  });
});
