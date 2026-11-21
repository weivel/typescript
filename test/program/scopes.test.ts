import { describe, expect, it } from "vitest";
import type { Host, LoadedLibrary } from "../../src/host/index.ts";
import { PluginScopes, type RefusedScope } from "../../src/program/scopes.ts";
import type { StandardServiceIds } from "../../src/standard/index.ts";
import { recordingLogger } from "../context/world.ts";

const ids: StandardServiceIds = {
  config: "weivel.config",
  secrets: "weivel.secrets",
  paths: "weivel.paths",
  log: "weivel.log",
  scope: "weivel.scope",
  host: "weivel.host",
};

interface ScopeWorld {
  readonly events: string[];
  readonly scopes: PluginScopes;
  readonly log: ReturnType<typeof recordingLogger>;
}

/**
 * Scopes over a host that offers each definition until it reaches `refusedId`, which it refuses, and whose
 * withdrawal of `failingWithdrawal` throws; every offer, withdrawal and release is recorded in `events`.
 */
function scopeWorld(refusedId: string, failingWithdrawal?: string): ScopeWorld {
  const events: string[] = [];
  const host = {
    registerPluginService(_plugin: bigint, type: { id: string }) {
      if (type.id === refusedId) {
        throw new Error(`a loaded library declares ${type.id}`);
      }
      events.push(`offer ${type.id}`);
      return () => {
        events.push(`withdraw ${type.id}`);
        if (type.id === failingWithdrawal) {
          throw new Error(`withdrawing ${type.id} failed`);
        }
      };
    },
  } as unknown as Host;
  const answer = { config: {}, secrets: {}, paths: {}, log: {}, release: () => events.push("release scope") };
  const provider = { open: async () => answer };
  const library = { described: new Map([[ids.scope, provider]]) } as unknown as LoadedLibrary;
  const log = recordingLogger();
  const scopes = new PluginScopes(host, ids, log.logger);
  scopes.askOf([library]);
  return { events, scopes, log };
}

describe("a plugin's scope that cannot be offered in full", () => {
  it("withdraws every definition offered before the one refused, then releases the scope, and answers why", async () => {
    const world = scopeWorld("weivel.paths");

    const opened = await world.scopes.open(1n, "alpha/manifest.json");

    expect((opened as RefusedScope).refused).toMatch(/could not be offered: a loaded library declares weivel\.paths/);
    expect(world.events).toEqual(["offer weivel.config", "offer weivel.secrets", "withdraw weivel.config", "withdraw weivel.secrets", "release scope"]);
  });

  it("answers the refusal that stopped the offer, not a withdrawal that failed on the way out, which it logs", async () => {
    const world = scopeWorld("weivel.log", "weivel.config");

    const opened = await world.scopes.open(1n, "alpha/manifest.json");

    expect((opened as RefusedScope).refused).toMatch(/a loaded library declares weivel\.log/);
    expect(world.events).toEqual([
      "offer weivel.config",
      "offer weivel.secrets",
      "offer weivel.paths",
      "withdraw weivel.config",
      "withdraw weivel.secrets",
      "withdraw weivel.paths",
      "release scope",
    ]);
    expect(world.log.entries.map((entry) => entry.message)).toEqual([expect.stringMatching(/withdrawing weivel\.config failed/)]);
  });
});
