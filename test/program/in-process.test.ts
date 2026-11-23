import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HostProgramRun } from "../../src/conformance/index.ts";
import { failedRunExit, startHost, type RunningHost } from "../../src/program/index.ts";
import { recordingLogger } from "../context/world.ts";
import { coreLibraryPath } from "../real-core.ts";
import { standardLibraryPath } from "../real-standard.ts";
import { hostTestTimeout, hostVector, stubHostLibraryPath, witness } from "./world.ts";

interface Greeter {
  greet(given: unknown): Promise<unknown>;
}

function greeterVector(stubHost: Record<string, unknown>): ReturnType<typeof hostVector> {
  return hostVector("program/in-process", {
    stubHost: { mode: "serve", plugins: [{ name: "alpha", directory: "alpha", manifest: "alpha/manifest.json", scope: true }], ...stubHost },
    plugins: [{ name: "alpha", provides: { "alpha:greeter": { greet: { echo: true } } } }],
  });
}

function recordOf(directory: string): string[] {
  return readFileSync(join(directory, "record.txt"), "utf8").split("\n").filter((line) => line !== "");
}

/** Starts the program in process over the vector's directory and hands the running host to `use` before stopping it. */
function startedRun(use: (running: RunningHost, directory: string) => Promise<void>): HostProgramRun {
  return async (programArguments) => {
    const running = await startHost({ hostLibraryPath: stubHostLibraryPath, arguments: programArguments, coreLibraryPath, standardLibraryPath, log: recordingLogger().logger });
    await use(running, programArguments[0]!);
    return running.stop();
  };
}

describe("startHost", () => {
  it(
    "answers once started was told, with the service a plugin registered, and stops with stop's code",
    async () => {
      const seen = { atStart: [] as string[], answered: undefined as unknown, absent: undefined as unknown, otherPlugin: undefined as unknown };

      const witnessed = await witness(
        greeterVector({ exit: 7 }),
        startedRun(async (running, directory) => {
          seen.atStart = recordOf(directory);
          seen.answered = await running.service<Greeter>("alpha", "alpha:greeter")?.greet(["hello", 1]);
          seen.absent = running.service("alpha", "alpha:absent");
          seen.otherPlugin = running.service("beta", "alpha:greeter");
        }),
      );

      expect(seen.atStart).toContain("started 1");
      expect(seen.answered).toEqual(["hello", 1]);
      expect(seen.absent).toBeUndefined();
      expect(seen.otherPlugin).toBeUndefined();
      expect(witnessed.record.at(-1)).toBe("stop");
      expect(witnessed.exit).toBe(7);
    },
    hostTestTimeout,
  );

  it(
    "answers the same code to every stop, and no service once stopped",
    async () => {
      const after = { second: 0, service: undefined as unknown, serviceBefore: undefined as unknown };
      const run: HostProgramRun = async (programArguments) => {
        const running = await startHost({ hostLibraryPath: stubHostLibraryPath, arguments: programArguments, coreLibraryPath, standardLibraryPath, log: recordingLogger().logger });
        after.serviceBefore = running.service("alpha", "alpha:greeter");
        const first = await running.stop();
        after.second = await running.stop();
        after.service = running.service("alpha", "alpha:greeter");
        return first;
      };

      const witnessed = await witness(greeterVector({ exit: 3 }), run);

      expect(witnessed.exit).toBe(3);
      expect(after.second).toBe(3);
      expect(after.serviceBefore).toBeDefined();
      expect(after.service).toBeUndefined();
    },
    hostTestTimeout,
  );

  it("answers a host whose stop answers the failed run's code, and no service, when start refuses", async () => {
    const answered = { service: undefined as unknown };

    const witnessed = await witness(
      greeterVector({ refuse: { start: "no" } }),
      startedRun(async (running) => {
        answered.service = running.service("alpha", "alpha:greeter");
      }),
    );

    expect(witnessed.record).toEqual(["start"]);
    expect(witnessed.exit).toBe(failedRunExit);
    expect(answered.service).toBeUndefined();
  });
});
