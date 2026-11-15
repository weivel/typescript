import { describe, expect, it } from "vitest";
import { EdgeSource, PluginStatus, RefusalCode, type Manifest } from "../../src/core/index.ts";
import { RefusalError, type PluginContext } from "../../src/context/index.ts";
import type { Plugin } from "../../src/host/index.ts";
import { alive, planned, createHostWorld, settle, type HostWorld } from "./world.ts";

type Trace = string[];

function registered(world: HostWorld, importName: string, entry: Plugin, manifest: Record<string, unknown> = {}): bigint {
  return alive(world.host.register({ importName, api: 1, ...manifest } as Manifest, entry)).plugin!;
}

function syncEntry(trace: Trace, name: string, body: (context: PluginContext) => void = () => undefined): Plugin {
  return {
    activate(context) {
      trace.push(`activate ${name}`);
      body(context);
    },
  };
}

const screens = { capabilities: { provides: ["screens"] } };

describe("activation as one step of a dispatch", () => {
  it("verifies an activate that settled at once before the next plugin starts", () => {
    const world = createHostWorld();
    let seenByTheNext: string[] | undefined;
    const provider = registered(
      world,
      "provider",
      { activate: (context) => context.provide(context.capability<{ name: string }>("screens"), { name: "provider" }) },
      screens,
    );
    const consumer = registered(
      world,
      "consumer",
      {
        activate(context) {
          seenByTheNext = context.capabilities.all(context.capability<{ name: string }>("screens")).map((screen) => screen.name);
        },
      },
      { capabilities: { consumes: ["screens"] } },
    );

    planned(world.host.activate([provider, consumer]));

    expect(seenByTheNext).toEqual(["provider"]);
  });

  it("quarantines an activate that settled at once and was refused before the next plugin starts", () => {
    const world = createHostWorld();
    const trace: Trace = [];
    let servedToTheNext: unknown = "never asked";
    const refused = registered(
      world,
      "refused",
      syncEntry(trace, "refused", (context) => void context.services.register(context.service("refused:thing"), { from: "refused" })),
      { ...screens, services: { provides: [{ id: "refused:thing" }] } },
    );
    const next = registered(
      world,
      "next",
      syncEntry(trace, "next", (context) => (servedToTheNext = context.services.get(context.service("refused:thing")))),
      { services: { consumes: [{ id: "refused:thing" }] } },
    );

    planned(world.host.activate([refused, next]));

    expect(trace).toEqual(["activate refused", "activate next"]);
    expect(servedToTheNext).toBeUndefined();
  });

  it("dispatches what an activate's own calls queued once every activate of the plan has been called", async () => {
    const world = createHostWorld();
    const trace: Trace = [];
    const watcher = registered(
      world,
      "watcher",
      syncEntry(trace, "watcher", (context) =>
        void context.services.watch(context.service("teller:thing"), (_service, change) => void trace.push(`heard ${change}`)),
      ),
      { services: { consumes: [{ id: "teller:thing" }] } },
    );
    const teller = registered(
      world,
      "teller",
      syncEntry(trace, "teller", (context) => void context.services.register(context.service("teller:thing"), {})),
      { services: { provides: [{ id: "teller:thing" }] } },
    );
    const last = registered(world, "last", syncEntry(trace, "last"));

    planned(world.host.activate([watcher, teller, last]));
    await settle();

    expect(trace).toEqual(["activate watcher", "activate teller", "activate last", "heard register"]);
  });

  it("starts a plan made while a dispatch runs as a call made inside it, its events behind the dispatch's own", async () => {
    const world = createHostWorld();
    const trace: Trace = [];
    const started = registered(
      world,
      "started",
      syncEntry(trace, "started", (context) => void context.services.register(context.service("started:thing"), {})),
      { services: { provides: [{ id: "started:thing" }] } },
    );
    const announcer = registered(
      world,
      "announcer",
      syncEntry(trace, "announcer", (context) => {
        context.services.watch(context.service("started:thing"), (_service, change) => void trace.push(`heard ${change}`));
        context.services.register(context.service("announcer:thing"), {});
      }),
      { services: { consumes: [{ id: "started:thing" }], provides: [{ id: "announcer:thing" }] } },
    );
    const starter = registered(
      world,
      "starter",
      syncEntry(trace, "starter", (context) =>
        void context.services.watch(context.service("announcer:thing"), () => {
          trace.push("starting");
          planned(world.host.activate([started]));
          trace.push("started");
        }),
      ),
      { services: { consumes: [{ id: "announcer:thing" }] } },
    );

    planned(world.host.activate([starter, announcer]));
    await settle();

    expect(trace).toEqual(["activate starter", "activate announcer", "starting", "activate started", "started", "heard register"]);
  });
});

describe("a plan the core refuses", () => {
  it("is answered as that refusal, as a value, never thrown", () => {
    const world = createHostWorld({}, { edgeSource: 99 as EdgeSource });
    const plugin = registered(world, "planned", { activate: () => undefined });

    const started = alive(world.host.activate([plugin]));

    expect(started.plan).toBeUndefined();
    expect(started.outcomes).toBeUndefined();
    expect(started.refusal).toBeInstanceOf(RefusalError);
    expect(started.refusal?.code).toBe(RefusalCode.MalformedCall);
  });
});

describe("what an outcome carries", () => {
  it("is the verification's refusal for a plugin that refusal quarantined", async () => {
    const world = createHostWorld();
    const plugin = registered(world, "refused", { activate: () => undefined }, screens);

    const [outcome] = await planned(world.host.activate([plugin])).outcomes;

    expect(outcome!.state).toBe("quarantined");
    expect(outcome!.refusal).toBeInstanceOf(RefusalError);
    expect(outcome!.refusal?.code).toBe(RefusalCode.ActivationMismatch);
    expect(alive(world.host.ledger()).rows.find((row) => row.plugin === plugin)?.status).toBe(PluginStatus.Quarantined);
  });

  it("is no refusal for a plugin quarantined because its activate failed, the reason kept in its ledger row", async () => {
    const world = createHostWorld();
    const plugin = registered(world, "thrower", {
      activate: () => {
        throw new Error("no luck");
      },
    });

    const [outcome] = await planned(world.host.activate([plugin])).outcomes;

    expect(outcome!.state).toBe("quarantined");
    expect(outcome!.refusal).toBeUndefined();
    const row = alive(world.host.ledger()).rows.find((entry) => entry.plugin === plugin)!;
    expect(row.refusal.code).toBe(RefusalCode.None);
    expect(row.refusal.detail).toBe("its activate threw: no luck");
    expect(row.refusal.hasFix).toBe(true);
  });
});
