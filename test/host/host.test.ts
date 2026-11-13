import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EdgeSource, LogLevel, PluginStatus, RefusalCode } from "../../src/core/index.ts";
import { RefusalError, type PluginContext } from "../../src/context/index.ts";
import { StandardRefusalCode } from "../../src/standard/index.ts";
import {
  createHostWorld,
  directoryContents,
  entrySource,
  linkDirectory,
  plugin,
  pluginDirectory,
  registerDirectory,
  settle,
  type HostWorld,
} from "./world.ts";

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
  return registerDirectory(world, directory).registered;
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

describe("registration", () => {
  it("registers a manifest value with the entry its caller hands in, and activates that entry", async () => {
    const world = createHostWorld();
    const entry = {
      activate: (context: PluginContext) => {
        probe().activated.push(context.manifest.importName);
      },
    };

    const answer = world.host.register({ importName: "inline", api: 1 }, entry);
    const report = await world.host.activate([answer.plugin!]);

    expect(answer.refusal).toBeUndefined();
    expect(world.host.plugin(answer.plugin!)).toEqual({ plugin: answer.plugin, manifest: { importName: "inline", api: 1 }, entry });
    expect(world.host.core.ledgerEntry(answer.plugin!).value?.importName).toBe("inline");
    expect(report.outcomes.map((outcome) => outcome.state)).toEqual(["active"]);
    expect(probe().activated).toEqual(["inline"]);
  });

  it("answers the core's refusal to register a plugin as data", () => {
    const world = createHostWorld();
    world.host.register({ importName: "alpha", api: 1 }, { activate() {} });

    const answer = world.host.register({ importName: "alpha", api: 1 }, { activate() {} });

    expect(answer.plugin).toBeUndefined();
    expect(answer.refusal?.code).toBe(RefusalCode.NameTaken);
  });
});

describe("plugins the standard discovers", () => {
  it("are registered in the standard's order, each with its entry on disk", () => {
    const world = createHostWorld();
    const directory = pluginDirectory([plugin({ importName: "beta" }), plugin({ importName: "alpha" })]);

    const registration = registerDirectory(world, directory);

    expect(registration.refusal).toBeUndefined();
    expect([...registration.registered.keys()]).toEqual(["alpha", "beta"]);
    expect(world.host.core.ledgerEntry(registration.registered.get("beta")!).value?.importName).toBe("beta");
    expect(world.host.plugin(registration.registered.get("alpha")!)?.manifest.importName).toBe("alpha");
  });

  it("leave out each file the standard could not take a plugin from, with its refusal", () => {
    const world = createHostWorld();
    const directory = pluginDirectory([plugin({ importName: "alpha" })]);
    writeFileSync(join(directory, "broken.json"), "{");

    const registration = registerDirectory(world, directory);

    expect([...registration.registered.keys()]).toEqual(["alpha"]);
    expect(registration.failures.map((failure) => [failure.file, failure.refusal.code])).toEqual([
      [`${directory}/broken.json`, StandardRefusalCode.MalformedJson],
    ]);
  });

  it("carry the identity file's id in the manifest the host registers", () => {
    const world = createHostWorld();
    const directory = pluginDirectory([{ ...plugin({ importName: "first" }), identity: { id: "forge:7", name: "first-repository" } }]);

    const registration = registerDirectory(world, directory);

    expect(world.host.plugin(registration.registered.get("first")!)?.manifest.identity).toBe("forge:7");
    expect(world.host.core.ledgerEntry(registration.registered.get("first")!).value?.identity).toBe("forge:7");
  });

  it("are refused by the core as data when a plugin of the name is registered already", () => {
    const world = createHostWorld();
    registerDirectory(world, pluginDirectory([plugin({ importName: "alpha" })]));
    const again = pluginDirectory([plugin({ importName: "alpha" })]);

    const registration = registerDirectory(world, again);

    expect(registration.registered.size).toBe(0);
    expect(registration.refused.map((refused) => [refused.manifestPath, refused.refusal.code])).toEqual([
      [`${again}/alpha.json`, RefusalCode.NameTaken],
    ]);
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

  it("starts a later plugin's activate while an earlier one still awaits the service that later plugin registers", async () => {
    const world = createHostWorld();
    const directory = pluginDirectory([
      plugin(
        { importName: "early", services: { consumes: ["late:thing"] } },
        "await context.services.want(context.service('late:thing'));",
      ),
      plugin({ importName: "late", services: { provides: ["late:thing"] } }, "context.services.register(context.service('late:thing'), {});"),
    ]);
    const handles = discovered(world, directory);
    const order = [handleOf(handles, "early"), handleOf(handles, "late")];

    const report = await Promise.race([
      world.host.activate(order),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2000)),
    ]);

    expect(report).not.toBe("hung");
    const settled = report as Exclude<typeof report, "hung">;
    expect(settled.plan.order).toEqual(order);
    expect(probe().activated).toEqual(["early", "late"]);
    expect(settled.outcomes.map((outcome) => [outcome.importName, outcome.state])).toEqual([
      ["early", "active"],
      ["late", "active"],
    ]);
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
      { manifest: { importName: "broken", entry: "broken.js" }, entrySource: "export default {\n" },
      { manifest: { importName: "unnamed" } },
    ]);
    const handles = discovered(world, directory);

    const report = await world.host.activate([...handles.values()]);

    expect(report.outcomes.map((outcome) => [outcome.importName, outcome.state])).toEqual([
      ["absent", "quarantined"],
      ["bare", "quarantined"],
      ["broken", "quarantined"],
      ["unnamed", "quarantined"],
    ]);
    const details = report.outcomes.map((outcome) => outcome.refusal?.detail);
    expect(details[0]).toBe(`its entry ${directory}/absent.js is not a regular file reached through no link`);
    expect(details[1]).toBe(`its entry ${directory}/bare.js has no default export with an activate function`);
    expect(details[2]?.startsWith(`its entry ${directory}/broken.js could not be loaded: `)).toBe(true);
    expect(details[3]).toBe("its manifest names no entry");
    expect(report.outcomes.every((outcome) => outcome.refusal?.hasFix === true)).toBe(true);
  });

  it("never imports an entry reached through a link, quarantining the plugin instead", async () => {
    const world = createHostWorld();
    const elsewhere = pluginDirectory([]);
    writeFileSync(join(elsewhere, "linked.js"), entrySource("linked", "", "js").replace("const probe", "globalThis.weivelHostProbe.activated.push('imported');\nconst probe"));
    const directory = pluginDirectory([{ manifest: { importName: "linked", entry: "lib/linked.js" } }]);
    linkDirectory(elsewhere, join(directory, "lib"));
    const handles = discovered(world, directory);

    const report = await world.host.activate([handleOf(handles, "linked")]);

    expect(report.outcomes[0]).toMatchObject({
      state: "quarantined",
      refusal: { detail: `its entry ${directory}/lib/linked.js is not a regular file reached through no link` },
    });
    expect(probe().activated).toEqual([]);
  });

  it("runs an entry as the file now is when a released plugin is discovered and activated again", async () => {
    const world = createHostWorld();
    const directory = pluginDirectory([plugin({ importName: "changing" }, "probe.version = 1;")]);
    const first = handleOf(discovered(world, directory), "changing");
    await world.host.activate([first]);
    await world.host.release(first);
    writeFileSync(join(directory, "changing.js"), entrySource("changing", "probe.version = 2;"));

    const second = handleOf(discovered(world, directory), "changing");
    const report = await world.host.activate([second]);

    expect(report.outcomes[0]?.state).toBe("active");
    expect(probe().activated).toEqual(["changing", "changing"]);
    expect((probe() as unknown as { version: number }).version).toBe(2);
  });

  it("writes a plugin's refused reach to the host's log as the core reports it", async () => {
    const world = createHostWorld();
    const handles = discovered(
      world,
      pluginDirectory([plugin({ importName: "reacher" }, "context.services.get(context.service('other:thing'));")]),
    );

    await world.host.activate([handleOf(handles, "reacher")]);

    const warnings = world.hostLog.entries.filter((entry) => entry.level === "warn").map((entry) => entry.message);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.startsWith("reacher was refused other:thing: ")).toBe(true);
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

describe("a refused activation check", () => {
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

describe("destroy", () => {
  it("deactivates and releases every active plugin, the latest activated first, before destroying the core", async () => {
    const world = createHostWorld();
    const handles = discovered(
      world,
      pluginDirectory([
        plugin({ importName: "agenda", capabilities: { consumes: ["screens"] } }),
        plugin(
          { importName: "calendar", capabilities: { provides: ["screens"] } },
          "context.provide(context.capability('screens'), { provider: 'calendar' });",
        ),
      ]),
    );
    await world.host.activate([...handles.values()]);

    await world.host.destroy();

    expect(probe().deactivated).toEqual(["agenda", "calendar"]);
    expect(world.host.plugin(handleOf(handles, "agenda"))).toBeUndefined();
    expect(world.host.plugin(handleOf(handles, "calendar"))).toBeUndefined();
  });

  it("leaves a host service's unregister doing nothing once the core is gone", async () => {
    const world = createHostWorld();
    const unregister = world.host.registerHostService({ id: "clock" }, {});

    await world.host.destroy();

    expect(() => unregister()).not.toThrow();
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
