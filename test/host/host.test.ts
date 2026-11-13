import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Axis, EdgeSource, LogLevel, PluginStatus, RefusalCode } from "../../src/core/index.ts";
import { RefusalError, type PluginContext, type PluginEvent } from "../../src/context/index.ts";
import { StandardRefusalCode } from "../../src/standard/index.ts";
import { createHostWorld, directoryContents, plugin, pluginDirectory, settle, type HostWorld } from "./world.ts";

const probe = () => globalThis.weivelHostProbe;

/** What the plugin that wanted a service stored in the probe: its want, settled to "served" or the rejection. */
function wantedOf(): Promise<unknown> {
  return (probe() as unknown as { wanted: Promise<unknown> }).wanted;
}

function contextOf(name: string): PluginContext {
  const context = probe().contexts.get(name);
  if (context === undefined) {
    throw new Error(`${name} was never activated`);
  }
  return context;
}

function discovered(world: HostWorld, directory: string): Map<string, bigint> {
  return new Map(world.host.discover(directory).registered.map((hosted) => [hosted.manifest.importName, hosted.plugin]));
}

function handleOf(handles: Map<string, bigint>, name: string): bigint {
  const handle = handles.get(name);
  if (handle === undefined) {
    throw new Error(`${name} was not registered`);
  }
  return handle;
}

function quarantinedNames(world: HostWorld): (string | null)[] {
  return world.host.core
    .ledger()
    .value!.rows.filter((row) => row.status === PluginStatus.Quarantined)
    .map((row) => row.importName);
}

describe("discovering plugins", () => {
  it("registers what the standard discovers, in the standard's order", () => {
    const world = createHostWorld();
    const directory = pluginDirectory([plugin({ importName: "beta" }), plugin({ importName: "alpha" })]);

    const report = world.host.discover(directory);

    expect(report.refusal).toBeUndefined();
    expect(report.registered.map((hosted) => hosted.manifest.importName)).toEqual(["alpha", "beta"]);
    expect(report.registered[0]!.entryPath).toBe(`${directory}/alpha.js`);
    expect(world.host.core.ledgerEntry(report.registered[1]!.plugin).value?.importName).toBe("beta");
    expect(world.host.plugin(report.registered[0]!.plugin)?.manifest.importName).toBe("alpha");
  });

  it("answers the standard's refusal of each file it could not take a plugin from", () => {
    const world = createHostWorld();
    const directory = pluginDirectory([plugin({ importName: "alpha" })]);
    writeFileSync(join(directory, "broken.json"), "{");

    const report = world.host.discover(directory);

    expect(report.registered.map((hosted) => hosted.manifest.importName)).toEqual(["alpha"]);
    expect(report.failures.map((failure) => [failure.file, failure.refusal.code])).toEqual([
      [`${directory}/broken.json`, StandardRefusalCode.MalformedJson],
    ]);
  });

  it("answers the standard's refusal of a directory that does not exist", () => {
    const world = createHostWorld();

    const report = world.host.discover(join(pluginDirectory([]), "absent"));

    expect(report.refusal?.code).toBe(StandardRefusalCode.NotFound);
    expect(report.registered).toEqual([]);
  });

  it("registers the identity file's id with the manifest", () => {
    const world = createHostWorld();
    const directory = pluginDirectory([{ ...plugin({ importName: "first" }), identity: { id: "forge:7", name: "first-repository" } }]);

    const report = world.host.discover(directory);

    expect(report.registered.map((hosted) => hosted.manifest.identity)).toEqual(["forge:7"]);
    expect(world.host.core.ledgerEntry(report.registered[0]!.plugin).value?.identity).toBe("forge:7");
  });

  it("answers the core's refusal to register a plugin as data", () => {
    const world = createHostWorld();
    world.host.discover(pluginDirectory([plugin({ importName: "alpha" })]));
    const again = pluginDirectory([plugin({ importName: "alpha" })]);

    const report = world.host.discover(again);

    expect(report.registered).toEqual([]);
    expect(report.refused.map((refused) => [refused.manifestPath, refused.refusal.code])).toEqual([
      [`${again}/alpha.json`, RefusalCode.NameTaken],
    ]);
  });
});

describe("supports", () => {
  it("reports a plugin the core does not support with the core's answer, and never registers or loads it", async () => {
    const world = createHostWorld({ applications: ["here"] });
    const directory = pluginDirectory([
      plugin({ importName: "elsewhere", targets: ["there"] }),
      plugin({ importName: "later", api: 99 }),
      plugin({ importName: "local", targets: ["here"] }),
    ]);

    const report = world.host.discover(directory);
    await world.host.activate(report.registered.map((hosted) => hosted.plugin));

    expect(report.registered.map((hosted) => hosted.manifest.importName)).toEqual(["local"]);
    expect(report.unsupported.map((unsupported) => [unsupported.manifest.importName, unsupported.support.axis])).toEqual([
      ["elsewhere", Axis.Application],
      ["later", Axis.Api],
    ]);
    expect(report.unsupported[0]!.support.refusal.code).toBe(RefusalCode.Incompatible);
    expect(world.host.core.ledger().value!.rows.map((row) => row.importName)).toEqual(["local"]);
    expect(probe().activated).toEqual(["local"]);
  });
});

describe("activation", () => {
  it("activates in the core's order, each plugin opened, activated and verified", async () => {
    const world = createHostWorld();
    const directory = pluginDirectory([
      plugin({ importName: "agenda", capabilities: { consumes: ["screens"] } }),
      plugin(
        { importName: "calendar", capabilities: { provides: ["screens"] } },
        "context.provide(context.capability('screens'), { provider: 'calendar' });",
      ),
    ]);
    const handles = discovered(world, directory);

    const report = await world.host.activate([handleOf(handles, "agenda"), handleOf(handles, "calendar")]);

    expect(report.plan.order).toEqual([handleOf(handles, "calendar"), handleOf(handles, "agenda")]);
    expect(probe().activated).toEqual(["calendar", "agenda"]);
    expect(report.outcomes.map((outcome) => [outcome.importName, outcome.state])).toEqual([
      ["calendar", "active"],
      ["agenda", "active"],
    ]);
    expect(world.host.core.ledgerEntry(handleOf(handles, "calendar")).value).toMatchObject({
      status: PluginStatus.Active,
      verified: true,
    });
    expect(world.host.core.pluginPayload(handleOf(handles, "agenda")).value).toBe(handleOf(handles, "agenda"));
  });

  it("loads an entry written in TypeScript as it loads one in JavaScript", async () => {
    const world = createHostWorld();
    const directory = pluginDirectory([plugin({ importName: "typed" }, "", "ts"), plugin({ importName: "plain" })]);
    const handles = discovered(world, directory);

    const report = await world.host.activate([...handles.values()]);

    expect(report.outcomes.map((outcome) => outcome.state)).toEqual(["active", "active"]);
    expect([...probe().activated].sort()).toEqual(["plain", "typed"]);
  });

  it("quarantines a plugin whose activate throws, with the reason in its ledger row, and activates the rest", async () => {
    const world = createHostWorld({ minimumLogLevel: LogLevel.Info });
    const directory = pluginDirectory([
      plugin({ importName: "angry" }, "throw new Error('no disk');"),
      plugin({ importName: "calm" }),
    ]);
    const handles = discovered(world, directory);

    const report = await world.host.activate([handleOf(handles, "angry"), handleOf(handles, "calm")]);

    expect(report.outcomes.map((outcome) => [outcome.importName, outcome.state])).toEqual([
      ["angry", "quarantined"],
      ["calm", "active"],
    ]);
    const row = world.host.core.ledgerEntry(handleOf(handles, "angry")).value!;
    expect(row.status).toBe(PluginStatus.Quarantined);
    expect(row.refusal.detail).toBe("its activate threw: no disk");
    expect(row.refusal.hasFix).toBe(true);
    expect(report.outcomes[0]!.refusal).toEqual(row.refusal);
    expect(world.hostLog.entries).toContainEqual({
      level: "info",
      message: 'quarantined the plugin "angry": its activate threw: no disk',
      cause: undefined,
    });
  });

  it("quarantines a plugin whose entry cannot be activated, saying why", async () => {
    const world = createHostWorld();
    const directory = pluginDirectory([
      { manifest: { importName: "absent", entry: "absent.js" } },
      { manifest: { importName: "bare", entry: "bare.js" }, entrySource: "export const nothing = 1;\n" },
      { manifest: { importName: "unnamed" } },
    ]);
    const handles = discovered(world, directory);

    const report = await world.host.activate([...handles.values()]);

    expect(report.outcomes.map((outcome) => [outcome.importName, outcome.state])).toEqual([
      ["absent", "quarantined"],
      ["bare", "quarantined"],
      ["unnamed", "quarantined"],
    ]);
    const details = report.outcomes.map((outcome) => outcome.refusal?.detail);
    expect(details[0]?.startsWith(`its entry ${directory}/absent.js could not be loaded: `)).toBe(true);
    expect(details[1]).toBe(`its entry ${directory}/bare.js has no default export with an activate function`);
    expect(details[2]).toBe("its manifest names no entry");
    expect(report.outcomes.every((outcome) => outcome.refusal?.hasFix === true)).toBe(true);
  });

  it("answers the core's refusal of a plugin it will not open as data", async () => {
    const world = createHostWorld();
    const handles = discovered(world, pluginDirectory([plugin({ importName: "twice" })]));
    world.host.open(handleOf(handles, "twice"));

    const report = await world.host.activate([handleOf(handles, "twice")]);

    expect(report.outcomes).toEqual([
      expect.objectContaining({ importName: "twice", state: "refused", refusal: expect.objectContaining({ code: RefusalCode.PluginState }) }),
    ]);
  });
});

describe("consume/a-refused-verify-quarantines-the-plugin", () => {
  it("quarantines the refused plugin in the same step, its watch stopping there, and reports no refusal", async () => {
    const world = createHostWorld();
    const handles = discovered(
      world,
      pluginDirectory([
        { manifest: { importName: "agenda", capabilities: { consumes: ["screens"] } } },
        { manifest: { importName: "calendar", entry: "calendar.js", capabilities: { provides: ["screens"] } } },
        { manifest: { importName: "flaky", entry: "flaky.js", capabilities: { provides: ["screens", "extras"], consumes: ["screens"] } } },
      ]),
    );
    const agenda = world.host.open(handleOf(handles, "agenda"));
    const calendar = world.host.open(handleOf(handles, "calendar"));
    const flaky = world.host.open(handleOf(handles, "flaky"));
    const pluginEvents: PluginEvent[] = [];
    for (const context of [agenda, calendar, flaky]) {
      context.events.listen((event) => pluginEvents.push(event));
    }
    const heard: [string, string][][] = [[], []];
    const watchScreens = (context: PluginContext, into: [string, string][]) =>
      context.capabilities.watch(context.capability<{ provider: string }>("screens"), (implementation, change) =>
        into.push([implementation.provider, change]),
      );

    watchScreens(agenda, heard[0]!);
    watchScreens(flaky, heard[1]!);
    calendar.provide(calendar.capability("screens"), { provider: "calendar" });
    const calendarVerified = world.host.verify(handleOf(handles, "calendar"));
    flaky.provide(flaky.capability("screens"), { provider: "flaky" });
    const flakyVerified = world.host.verify(handleOf(handles, "flaky"));
    await world.host.release(handleOf(handles, "calendar"));

    expect(heard).toEqual([
      [
        ["calendar", "provide"],
        ["calendar", "withdraw"],
      ],
      [["calendar", "provide"]],
    ]);
    expect(calendarVerified.state).toBe("active");
    expect(flakyVerified.state).toBe("quarantined");
    expect(quarantinedNames(world)).toEqual(["flaky"]);
    const reason = world.host.core.ledgerEntry(handleOf(handles, "flaky")).value!.refusal;
    expect(reason).toMatchObject({ code: RefusalCode.ActivationMismatch, subject: "flaky", hasFix: true });
    expect(flakyVerified.refusal).toEqual(reason);
    expect(world.host.contexts.tracked(handleOf(handles, "flaky"))).toBe(0);
    expect(pluginEvents.filter((event) => event.kind === "reach-refused")).toEqual([]);
    expect(world.host.core.ledger().value!.refusals).toEqual([]);
  });

  it("quarantines a plugin whose activation the core refuses after activate ran", async () => {
    const world = createHostWorld();
    const handles = discovered(world, pluginDirectory([plugin({ importName: "liar", capabilities: { provides: ["screens"] } })]));

    const report = await world.host.activate([handleOf(handles, "liar")]);

    expect(report.outcomes[0]).toMatchObject({ state: "quarantined", refusal: { code: RefusalCode.ActivationMismatch, subject: "liar" } });
    expect(quarantinedNames(world)).toEqual(["liar"]);
  });
});

describe("release", () => {
  const waiter = plugin(
    { importName: "waiter", services: { consumes: ["nobody:thing"], provides: ["waiter:greeting"] } },
    [
      "probe.wanted = context.services.want(context.service('nobody:thing')).then(() => 'served', (error) => error);",
      "context.services.register(context.service('waiter:greeting'), { hello: () => 'hello' });",
      "context.services.watch(context.service('nobody:thing'), () => undefined);",
    ].join(" "),
  );

  it("deactivates, releases and forgets the plugin, settling its pending want and freeing every table", async () => {
    const world = createHostWorld();
    const handles = discovered(world, pluginDirectory([waiter]));
    const handle = handleOf(handles, "waiter");
    await world.host.activate([handle]);
    expect(world.host.contexts.tracked(handle)).toBeGreaterThan(0);

    await world.host.release(handle);
    const wanted = await Promise.race([wantedOf(), settle().then(() => "still pending")]);

    expect(probe().deactivated).toEqual(["waiter"]);
    expect(wanted).toBeInstanceOf(RefusalError);
    expect((wanted as RefusalError).code).toBe(RefusalCode.Stopped);
    expect(world.host.contexts.tracked(handle)).toBe(0);
    expect(world.host.plugin(handle)).toBeUndefined();
    expect(world.host.core.ledgerEntry(handle).value).toBeUndefined();
    expect(world.host.core.ledger().value!.rows).toEqual([]);
  });

  it("settles the pending want of a plugin released from a listener while the layer still handles events", async () => {
    const world = createHostWorld();
    const watcher = plugin(
      { importName: "watcher", services: { consumes: ["nobody:thing", "trigger:ping"] } },
      "probe.wanted = context.services.want(context.service('nobody:thing')).then(() => 'served', (error) => error);",
    );
    const handles = discovered(
      world,
      pluginDirectory([watcher, plugin({ importName: "trigger", services: { provides: ["trigger:ping"] } })]),
    );
    const watcherHandle = handleOf(handles, "watcher");
    await world.host.activate([watcherHandle, handleOf(handles, "trigger")]);
    const released: Promise<void>[] = [];
    const watcherContext = contextOf("watcher");
    watcherContext.services.watch(watcherContext.service("trigger:ping"), () => {
      released.push(world.host.release(watcherHandle));
    });

    contextOf("trigger").services.register(contextOf("trigger").service("trigger:ping"), {});
    await Promise.all(released);
    const wanted = await Promise.race([wantedOf(), settle().then(() => "still pending")]);

    expect(released).toHaveLength(1);
    expect(wanted).toBeInstanceOf(RefusalError);
    expect((wanted as RefusalError).code).toBe(RefusalCode.Stopped);
    expect(world.host.contexts.tracked(watcherHandle)).toBe(0);
    expect(world.host.plugin(watcherHandle)).toBeUndefined();
  });

  it("never writes a manifest-named file into the plugin directory", async () => {
    const world = createHostWorld();
    const directory = pluginDirectory([waiter, plugin({ importName: "angry" }, "throw new Error('no');")]);
    const before = directoryContents(directory);

    const handles = discovered(world, directory);
    await world.host.activate([...handles.values()]);
    for (const handle of handles.values()) {
      await world.host.release(handle);
    }
    await settle();

    expect(directoryContents(directory)).toEqual(before);
  });
});

describe("host services", () => {
  it("are registered under the host, reached as the host's own object, and meet a plan's mandatory need", async () => {
    const world = createHostWorld({}, { edgeSource: EdgeSource.Services });
    const clockService = { now: () => 42 };
    const handles = discovered(
      world,
      pluginDirectory([
        plugin(
          { importName: "reader", services: { consumes: [{ id: "clock", optional: false }] } },
          "probe.reached = context.services.get(context.service('clock'));",
        ),
      ]),
    );
    const reader = handleOf(handles, "reader");

    const unmet = world.host.core.planActivation([reader], EdgeSource.Services, []).value!;
    world.host.registerHostService({ id: "clock" }, clockService);
    const report = await world.host.activate([reader]);

    expect(unmet.refusals.map((refusal) => refusal.refusal.code)).toEqual([RefusalCode.UnmetNeed]);
    expect(report.plan.refusals).toEqual([]);
    expect(report.outcomes.map((outcome) => outcome.state)).toEqual(["active"]);
    expect((probe() as unknown as { reached: unknown }).reached).toBe(clockService);
  });

  it("stop meeting a plan's need once unregistered", async () => {
    const world = createHostWorld({}, { edgeSource: EdgeSource.Services });
    const handles = discovered(
      world,
      pluginDirectory([plugin({ importName: "reader", services: { consumes: [{ id: "clock", optional: false }] } })]),
    );
    const unregister = world.host.registerHostService({ id: "clock" }, {});

    unregister();
    unregister();
    const report = await world.host.activate([handleOf(handles, "reader")]);

    expect(report.plan.refusals.map((refusal) => refusal.refusal.code)).toEqual([RefusalCode.UnmetNeed]);
    expect(report.outcomes).toEqual([]);
  });
});

describe("time", () => {
  it("arms the core's deadline on the host's scheduler, so a timed want times out when it fires", async () => {
    const world = createHostWorld();
    const handles = discovered(
      world,
      pluginDirectory([
        plugin(
          { importName: "patient", services: { consumes: ["nobody:thing"] } },
          "probe.wanted = context.services.want(context.service('nobody:thing'), { timeoutMillis: 50 }).then(() => 'served', (error) => error);",
        ),
      ]),
    );
    await world.host.activate([handleOf(handles, "patient")]);

    expect([...world.scheduler.armed.values()].map((task) => task.delayMilliseconds)).toEqual([50]);
    world.clock.time = 50;
    world.scheduler.fire();
    const wanted = await wantedOf();

    expect((wanted as RefusalError).code).toBe(RefusalCode.TimedOut);
  });
});
