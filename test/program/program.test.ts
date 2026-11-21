import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { failedRunExit, main, runHost, terminateSignals } from "../../src/program/index.ts";
import { recordingLogger } from "../context/world.ts";
import { coreLibraryPath } from "../real-core.ts";
import { standardLibraryPath } from "../real-standard.ts";
import { hostTestTimeout, hostVector, stubHostCopy, stubHostDirectory, stubHostLibraryPath, temporaryDirectory, witness } from "./world.ts";

const stubHostDeclaration = JSON.parse(readFileSync(join(stubHostDirectory, "library.json"), "utf8")) as { services: { id: string }[] };

function serveWithNoPlugin(stubHost: Record<string, unknown>, stopAfter?: string): ReturnType<typeof hostVector> {
  return hostVector("program/serve", { stubHost: { mode: "serve", plugins: [], ...stubHost }, plugins: [], ...(stopAfter === undefined ? {} : { stopAfter }) });
}

describe("the host program's start", () => {
  it("exits non-zero and writes what went wrong when the host library is missing", async () => {
    const log = recordingLogger();
    const missing = join(temporaryDirectory(), "missing.dll");

    const exit = await runHost({ hostLibraryPath: missing, arguments: [], log: log.logger, coreLibraryPath, standardLibraryPath });

    expect(exit).toBe(failedRunExit);
    expect(log.entries.map((entry) => entry.message)).toEqual([expect.stringMatching(/library\.json could not be read/)]);
  });

  it("exits non-zero and calls nothing when the host library serves no weivel.host", async () => {
    const declaration = { ...stubHostDeclaration, services: stubHostDeclaration.services.filter((service) => service.id !== "weivel.host") };
    const hostLibraryPath = stubHostCopy(declaration);
    const directory = temporaryDirectory();
    const log = recordingLogger();

    const exit = await runHost({ hostLibraryPath, arguments: [directory], log: log.logger, coreLibraryPath, standardLibraryPath });

    expect(exit).toBe(failedRunExit);
    expect(existsSync(join(directory, "record.txt"))).toBe(false);
    expect(log.entries.map((entry) => entry.message)).toEqual([expect.stringMatching(/serves no described weivel\.host/)]);
  });

  it("exits non-zero and calls nothing else when start refuses", async () => {
    const seen = await witness(serveWithNoPlugin({ refuse: { start: "no" } }));

    expect(seen.record).toEqual(["start"]);
    expect(seen.exit).not.toBe(0);
  });
});

describe("the host program's serve run", () => {
  it(
    "ticks at once, then at each time answered and never early, and stops on the request with stop's code",
    async () => {
      const seen = await witness(serveWithNoPlugin({ ticks: [30, 60], exit: 5 }, "tick 3 on-time"));

      expect(seen.record).toEqual(["start", "started 0", "tick 1 first", "tick 2 on-time", "tick 3 on-time", "stop"]);
      expect(seen.exit).toBe(5);
    },
    hostTestTimeout,
  );

  it(
    "stops at once, ticking no more, on a request while the next tick is far away",
    async () => {
      const started = Date.now();
      const seen = await witness(serveWithNoPlugin({ ticks: [600_000] }, "tick 1 first"));

      expect(seen.record).toEqual(["start", "started 0", "tick 1 first", "stop"]);
      expect(seen.exit).toBe(0);
      expect(Date.now() - started).toBeLessThan(10_000);
    },
    hostTestTimeout,
  );

  it("calls stop without a tick when started refuses, and exits with stop's code", async () => {
    const seen = await witness(serveWithNoPlugin({ refuse: { started: "no" }, exit: 4 }));

    expect(seen.record).toEqual(["start", "started 0", "stop"]);
    expect(seen.exit).toBe(4);
  });

  it("calls stop at once when a tick refuses, ticking no more", async () => {
    const seen = await witness(serveWithNoPlugin({ ticks: [10, 20], refuse: { tick: 2 }, exit: 6 }));

    expect(seen.record).toEqual(["start", "started 0", "tick 1 first", "tick 2 on-time", "stop"]);
    expect(seen.exit).toBe(6);
  });

  it(
    "calls stop next, and no tick, for a request made before start answered",
    async () => {
      const stopRequest = new AbortController();
      stopRequest.abort();
      const seen = await witness(serveWithNoPlugin({}), (programArguments) =>
        runHost({ hostLibraryPath: stubHostLibraryPath, arguments: programArguments, signal: stopRequest.signal, coreLibraryPath, standardLibraryPath }),
      );

      expect(seen.record).toEqual(["start", "stop"]);
      expect(seen.exit).toBe(0);
    },
    hostTestTimeout,
  );
});

describe("the host program's command line", () => {
  it("names the platform's terminate signals", () => {
    expect(terminateSignals("win32")).toEqual(["SIGINT", "SIGBREAK"]);
    expect(terminateSignals("linux")).toEqual(["SIGINT", "SIGTERM"]);
    expect(terminateSignals("darwin")).toEqual(["SIGINT", "SIGTERM"]);
  });

  it.each(terminateSignals())(
    "takes %s as a stop request, and leaves no listener of it behind",
    async (signal) => {
      const listenersBefore = process.listenerCount(signal);
      const log = recordingLogger();
      const seen = await witness(serveWithNoPlugin({ exit: 3 }, "tick 1 first"), (programArguments, stopRequest) => {
        stopRequest.addEventListener("abort", () => process.emit(signal as "SIGINT"));
        return main([stubHostLibraryPath, ...programArguments], { coreLibraryPath, standardLibraryPath, log: log.logger });
      });

      expect(seen.record).toEqual(["start", "started 0", "tick 1 first", "stop"]);
      expect(seen.exit).toBe(3);
      expect(process.listenerCount(signal)).toBe(listenersBefore);
    },
    hostTestTimeout,
  );

  it("exits non-zero, running nothing, when no host library is named", async () => {
    expect(await main([])).toBe(failedRunExit);
  });
});
