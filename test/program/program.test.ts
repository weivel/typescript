import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HostProgramRun } from "../../src/conformance/index.ts";
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
    "tells started, then calls stop with no tick, for a request made before start answered",
    async () => {
      const stopRequest = new AbortController();
      stopRequest.abort();
      const seen = await witness(serveWithNoPlugin({}), (programArguments) =>
        runHost({ hostLibraryPath: stubHostLibraryPath, arguments: programArguments, signal: stopRequest.signal, coreLibraryPath, standardLibraryPath }),
      );

      expect(seen.record).toEqual(["start", "started 0", "stop"]);
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

/** A plan of the plugins `names`, each scoped and activating with no step, in the mode and with the members given. */
function withPlugins(names: readonly string[], stubHost: Record<string, unknown>, plugins: readonly Record<string, unknown>[] = []): Record<string, unknown> {
  return {
    stubHost: { plugins: names.map((name) => ({ name, directory: name, manifest: `${name}/manifest.json`, scope: true })), ...stubHost },
    plugins: names.map((name) => plugins.find((plugin) => plugin.name === name) ?? { name }),
  };
}

/** Runs the program in process after `prepare` has changed the directory the suite laid out. */
function preparedRun(prepare: (directory: string) => void, signal?: AbortSignal): HostProgramRun {
  return (programArguments, stopRequest) => {
    prepare(programArguments[0]!);
    return runHost({ hostLibraryPath: stubHostLibraryPath, arguments: programArguments, signal: signal ?? stopRequest, coreLibraryPath, standardLibraryPath, log: recordingLogger().logger });
  };
}

describe("the host program's plugins", () => {
  it("tells a plugin whose manifest cannot be read as refused with why, and activates the next", async () => {
    const vector = hostVector("program/plugins", withPlugins(["alpha", "beta"], { mode: "serve", refuse: { started: "enough" } }));

    const seen = await witness(vector, preparedRun((directory) => rmSync(join(directory, "alpha", "manifest.json"))));

    expect(seen.record).toEqual(["start", "open beta scoped", "started 2", "outcome alpha refused detail", "outcome beta activated no-detail", "stop"]);
  });

  it("offers every plugin nothing, and opens no scope, when no loaded library serves weivel.scope", async () => {
    const declaration = { ...stubHostDeclaration, services: stubHostDeclaration.services.filter((service) => service.id !== "weivel.scope") };
    const hostLibraryPath = stubHostCopy(declaration);
    const absent = ["weivel.config", "weivel.secrets", "weivel.paths", "weivel.log"].map((id) => ({ absent: id }));
    const vector = hostVector("program/plugins", withPlugins(["alpha"], { mode: "serve", refuse: { started: "enough" } }, [{ name: "alpha", activate: absent }]));

    const seen = await witness(vector, (programArguments, signal) => runHost({ hostLibraryPath, arguments: programArguments, signal, coreLibraryPath, standardLibraryPath }));

    expect(seen.record).toEqual(["start", "started 1", "outcome alpha activated no-detail", "stop"]);
  });

  it(
    "activates every plugin and tells started, then calls stop with no tick, for a stop requested while a plugin activates",
    async () => {
      const stopRequest = new AbortController();
      const requester = globalThis as { weivelRequestStop?: () => void };
      requester.weivelRequestStop = () => stopRequest.abort();
      const stopping = "export default { activate() { globalThis.weivelRequestStop(); } };";
      const vector = hostVector("program/plugins", withPlugins(["alpha", "beta"], { mode: "serve" }));

      const seen = await witness(vector, preparedRun((directory) => writeFileSync(join(directory, "alpha", "entry.js"), stopping), stopRequest.signal));

      expect(seen.record).toEqual(["start", "open alpha scoped", "open beta scoped", "started 2", "outcome alpha activated no-detail", "outcome beta activated no-detail", "stop"]);
      delete requester.weivelRequestStop;
    },
    hostTestTimeout,
  );
});

describe("the host program's plan libraries", () => {
  it("ends the run at a library that will not load, activating no plugin, and still calls stop", async () => {
    const libraries = [{ binary: "lib/missing.dll", declaration: "lib/library.json" }];
    const vector = hostVector("program/libraries", withPlugins(["alpha"], { mode: "serve", libraries, exit: 8 }));

    const seen = await witness(vector);

    expect(seen.record).toEqual(["start", "stop"]);
    expect(seen.exit).toBe(8);
  });
});

describe("the host program's action run", () => {
  it(
    "runs no action and tells finished nothing for a stop requested while a plugin activates",
    async () => {
      const stopRequest = new AbortController();
      const requester = globalThis as { weivelRequestStop?: () => void };
      requester.weivelRequestStop = () => stopRequest.abort();
      const stopping = "export default { activate() { globalThis.weivelRequestStop(); }, actions: { echo: (given) => given } };";
      const vector = hostVector("program/action", withPlugins(["alpha"], { mode: "action", action: { plugin: "alpha", name: "echo" } }));

      const seen = await witness(vector, preparedRun((directory) => writeFileSync(join(directory, "alpha", "entry.js"), stopping), stopRequest.signal));

      expect(seen.record).toEqual(["start", "open alpha scoped", "started 1", "outcome alpha activated no-detail", "stop"]);
      delete requester.weivelRequestStop;
    },
    hostTestTimeout,
  );

  function actionRun(name: string, plugin: Record<string, unknown>, stubPlugin: Record<string, unknown> = {}): ReturnType<typeof hostVector> {
    const given = withPlugins(["alpha"], { mode: "action", action: { plugin: "alpha", name }, exit: 2 }, [{ name: "alpha", ...plugin }]);
    const stubHost = given.stubHost as { plugins: Record<string, unknown>[] };
    return hostVector("program/action", { ...given, stubHost: { ...stubHost, plugins: stubHost.plugins.map((stub) => ({ ...stub, ...stubPlugin })) } });
  }

  it("tells finished a failure, never ticking, for an action the plugin does not offer", async () => {
    const seen = await witness(actionRun("missing", { actions: { other: {} } }));

    expect(seen.record).toEqual(["start", "open alpha scoped", "started 1", "outcome alpha activated no-detail", "finished failure", "stop"]);
    expect(seen.exit).toBe(2);
  });

  it("tells finished a failure for an action of a plugin that was not activated", async () => {
    const seen = await witness(actionRun("echo", { actions: { echo: { echo: true } } }, { scope: undefined, scopeRefused: "no" }));

    expect(seen.record).toEqual(["start", "open alpha refused", "started 1", "outcome alpha refused detail", "finished failure", "stop"]);
  });

  it("tells finished a failure for an action answering what no value tree holds", async () => {
    const answeringAFunction = "export default { activate() {}, actions: { odd: () => () => 1 } };";

    const seen = await witness(actionRun("odd", {}), preparedRun((directory) => writeFileSync(join(directory, "alpha", "entry.js"), answeringAFunction)));

    expect(seen.record).toEqual(["start", "open alpha scoped", "started 1", "outcome alpha activated no-detail", "finished failure", "stop"]);
  });

  it("hands the action its arguments as the plan carried them, and tells finished an awaited answer", async () => {
    const awaiting = "export default { activate() {}, actions: { later: async (given) => ({ given }) } };";
    const vector = actionRun("later", {});
    const stubHost = vector.given.stubHost as Record<string, unknown>;
    const withArguments = hostVector("program/action", { ...vector.given, stubHost: { ...stubHost, action: { plugin: "alpha", name: "later", arguments: [true, null, "x"] } } });

    const seen = await witness(withArguments, preparedRun((directory) => writeFileSync(join(directory, "alpha", "entry.js"), awaiting)));

    expect(seen.record).toContain('finished result {"given":[true,null,"x"]}');
  });
});
