import { describe, expect, it } from "vitest";
import type { LoadedLibrary } from "../../src/host/index.ts";
import { HostProvider } from "../../src/program/provider.ts";

/** A host library serving `weivel.host` whose `tick` answers `has_next`. */
function tickingLibrary(hasNext: number): LoadedLibrary {
  const bound = { tick: async () => ({ has_next: hasNext, next: 5 }) };
  return { declaration: { importName: "ticking" }, described: new Map([["weivel.host", bound]]) } as unknown as LoadedLibrary;
}

describe("the host provider's tick", () => {
  it("answers the next time for has_next 1 and none for 0", async () => {
    expect(await HostProvider.of(tickingLibrary(1), "weivel.host").tick(0)).toBe(5);
    expect(await HostProvider.of(tickingLibrary(0), "weivel.host").tick(0)).toBeUndefined();
  });

  it("refuses any other has_next as a malformed answer, which ends the run", async () => {
    await expect(HostProvider.of(tickingLibrary(2), "weivel.host").tick(0)).rejects.toThrow(/has_next 2/);
  });
});
