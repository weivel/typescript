import { describe, expect, it, vi } from "vitest";
import { Bound, HOST, ReachKind, RefusalCode, Status, type CoreEvent, type Manifest } from "../../src/core/index.ts";
import { DetachedError, RefusalError, type PluginEvent } from "../../src/context/index.ts";
import { openPlugin } from "../real-core.ts";
import { createWorld, recordingLogger, settle } from "./world.ts";

interface Greeting {
  greet(name: string): string;
}

const greetingId = "alpha:greeting";
const provider: Manifest = { importName: "alpha", services: { provides: [{ id: greetingId }] } };
const consumer = (importName: string, ...ids: string[]): Manifest => ({
  importName,
  services: { consumes: (ids.length === 0 ? [greetingId] : ids).map((id) => ({ id })) },
});

function greeting(): Greeting {
  return { greet: (name) => `hello ${name}` };
}

/** Records how a promise ended, without waiting for it. */
function track<Value>(promise: Promise<Value>) {
  const outcome: { value?: Value; reason?: unknown; settled: boolean } = { settled: false };
  promise.then(
    (value) => Object.assign(outcome, { value, settled: true }),
    (reason) => Object.assign(outcome, { reason, settled: true }),
  );
  return outcome;
}

describe("services.get", () => {
  it("answers the provider's own object, identical, and nothing when nothing is registered", () => {
    const world = createWorld();
    const alpha = world.open(provider);
    const beta = world.open(consumer("beta"));
    const key = beta.context.service<Greeting>(greetingId);

    expect(beta.context.services.get(key)).toBeUndefined();
    const service = greeting();
    alpha.context.services.register(alpha.context.service<Greeting>(greetingId), service);

    expect(beta.context.services.get(key)).toBe(service);
    expect(beta.context.services.get(key)?.greet("beta")).toBe("hello beta");
  });

  it("throws the core's refusal for an id the plugin does not reach, and reports the refusal on its events too", () => {
    const world = createWorld();
    const alpha = world.open(provider);
    alpha.context.services.register(alpha.context.service(greetingId), greeting());
    const gamma = world.open(consumer("gamma", "gamma:other"));
    const heard: PluginEvent[] = [];
    gamma.context.events.listen((event) => heard.push(event));

    expect(() => gamma.context.services.get(gamma.context.service(greetingId))).toThrow(
      expect.objectContaining({ name: "RefusalError", code: RefusalCode.Undeclared }),
    );

    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ kind: "reach-refused", reach: ReachKind.Service, id: greetingId });
    if (heard[0]?.kind === "reach-refused") {
      expect(heard[0].refusal.code).toBe(RefusalCode.Undeclared);
    }
  });
});

describe("services.want", () => {
  it("resolves on the settlement the registration causes, with the provider's object", async () => {
    const world = createWorld();
    const alpha = world.open(provider);
    const beta = world.open(consumer("beta"));
    const wanted = track(beta.context.services.want(beta.context.service<Greeting>(greetingId)));
    await settle();
    expect(wanted.settled).toBe(false);

    const service = greeting();
    alpha.context.services.register(alpha.context.service<Greeting>(greetingId), service);
    await settle();

    expect(wanted.value).toBe(service);
  });

  it("resolves at once with a service already registered", async () => {
    const world = createWorld();
    const alpha = world.open(provider);
    const service = greeting();
    alpha.context.services.register(alpha.context.service<Greeting>(greetingId), service);
    const beta = world.open(consumer("beta"));

    await expect(beta.context.services.want(beta.context.service<Greeting>(greetingId))).resolves.toBe(service);
  });

  it("rejects with the core's refusal as data when the want times out", async () => {
    const world = createWorld();
    world.open(provider);
    const beta = world.open(consumer("beta"));
    world.clock.time = 500;
    const wanted = track(beta.context.services.want(beta.context.service(greetingId), { timeoutMillis: 1000 }));

    world.core.advance(1499);
    await settle();
    expect(wanted.settled).toBe(false);
    world.core.advance(1500);
    await settle();

    expect(wanted.reason).toBeInstanceOf(RefusalError);
    expect(wanted.reason).toMatchObject({ code: RefusalCode.TimedOut, subject: greetingId, hasFix: true });
    expect((wanted.reason as RefusalError).fix).not.toBeNull();
  });

  it("rejects at once with the refusal of reach", async () => {
    const world = createWorld();
    const gamma = world.open(consumer("gamma", "gamma:other"));

    const rejection = await gamma.context.services.want(gamma.context.service(greetingId)).catch((reason: unknown) => reason);

    expect(rejection).toBeInstanceOf(RefusalError);
    expect(rejection).toMatchObject({ code: RefusalCode.Undeclared, subject: greetingId });
  });

  it("stays pending across any advance when no timeout is asked, then settles when the service comes", async () => {
    const world = createWorld();
    const alpha = world.open(provider);
    const beta = world.open(consumer("beta"));
    const wanted = track(beta.context.services.want(beta.context.service<Greeting>(greetingId)));

    world.core.advance(Number.MAX_SAFE_INTEGER);
    await settle();
    expect(wanted.settled).toBe(false);
    expect(world.core.nextDeadline().status).toBe(Status.None);

    const service = greeting();
    alpha.context.services.register(alpha.context.service<Greeting>(greetingId), service);
    await settle();
    expect(wanted.value).toBe(service);
  });
});

describe("services.watch", () => {
  it("hears registrations and removals in the order the core reports them", () => {
    const world = createWorld();
    const alpha = world.open(provider);
    const beta = world.open(consumer("beta"));
    const heard: [Greeting | undefined, string][] = [];
    beta.context.services.watch(beta.context.service<Greeting>(greetingId), (service, change) => heard.push([service, change]));
    const first = greeting();
    const second = greeting();
    const key = alpha.context.service<Greeting>(greetingId);

    const unregisterFirst = alpha.context.services.register(key, first);
    unregisterFirst();
    alpha.context.services.register(key, second);

    expect(heard).toEqual([
      [first, "register"],
      [undefined, "unregister"],
      [second, "register"],
    ]);
    expect(heard[0]?.[0]).toBe(first);
    expect(heard[2]?.[0]).toBe(second);
  });

  it("hears nothing once its disposer is called, the core's watch ended with it", () => {
    const world = createWorld();
    const alpha = world.open(provider);
    const beta = world.open(consumer("beta"));
    const heard: string[] = [];
    const stop = beta.context.services.watch(beta.context.service(greetingId), (_service, change) => heard.push(change));

    stop();
    alpha.context.services.register(alpha.context.service(greetingId), greeting());

    expect(heard).toEqual([]);
    expect(world.dispatched.filter((event) => event.kind === "watch")).toEqual([]);
  });
});

describe("services.register", () => {
  it("offers the object until its disposer is called, which a second call leaves alone", () => {
    const world = createWorld();
    const alpha = world.open(provider);
    const beta = world.open(consumer("beta"));
    const key = beta.context.service<Greeting>(greetingId);
    const service = greeting();

    const unregister = alpha.context.services.register(alpha.context.service<Greeting>(greetingId), service);
    expect(beta.context.services.get(key)).toBe(service);
    unregister();
    expect(beta.context.services.get(key)).toBeUndefined();
    const refusalsBefore = world.dispatched.filter((event) => event.kind === "refusal").length;
    unregister();

    expect(world.dispatched.filter((event) => event.kind === "refusal")).toHaveLength(refusalsBefore);
  });

  it("throws the core's refusal for an id outside the plugin's namespace", () => {
    const world = createWorld();
    const alpha = world.open(provider);

    let thrown: unknown;
    try {
      alpha.context.services.register(alpha.context.service("beta:greeting"), greeting());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RefusalError);
    expect(thrown).toMatchObject({ code: RefusalCode.OutsideNamespace, subject: "beta:greeting" });
  });
});

describe("a host service", () => {
  it("is registered under the host and reached by a plugin as the host's own object", () => {
    const world = createWorld({ wellKnownServices: ["weivel.config"] });
    const config = { get: () => "value" };
    const unregister = world.contexts.registerHostService({ id: "weivel.config" }, config);
    const beta = world.open(consumer("beta", "weivel.config"));

    expect(beta.context.services.get(beta.context.service("weivel.config"))).toBe(config);
    unregister();
    expect(beta.context.services.get(beta.context.service("weivel.config"))).toBeUndefined();
  });
});

/** A context whose plugin is registered and was never opened, so the core refuses every call it makes. */
function neverOpened(world: ReturnType<typeof createWorld>) {
  const plugin = world.core.registerManifest({ importName: "idle", services: { consumes: [{ id: greetingId }] }, capabilities: { consumes: ["screens"] } }).value!;
  return world.contexts.create(plugin, { importName: "idle" }, recordingLogger().logger);
}

describe("a call the core refuses", () => {
  it("is answered with the refusal, by ids, watch, all and a capability watch alike", () => {
    const world = createWorld();
    const idle = neverOpened(world);
    const unreached = world.open(consumer("gamma", "gamma:other"));

    const answers = [
      () => idle.services.ids(),
      () => unreached.context.services.watch(unreached.context.service(greetingId), () => {}),
      () => unreached.context.capabilities.all(unreached.context.capability("screens")),
      () => unreached.context.capabilities.watch(unreached.context.capability("widgets"), () => {}),
    ].map((call) => {
      try {
        return call();
      } catch (error) {
        return error;
      }
    });

    expect(answers.map((answer) => answer instanceof RefusalError)).toEqual([true, true, true, true]);
  });
});

describe("services.ids", () => {
  it("answers the reachable ids registered now, as the core lists them", () => {
    const world = createWorld();
    const alpha = world.open(provider);
    const beta = world.open(consumer("beta", "gamma:other", greetingId));

    expect(beta.context.services.ids()).toEqual([]);
    alpha.context.services.register(alpha.context.service(greetingId), greeting());

    expect(beta.context.services.ids()).toEqual([greetingId]);
  });
});

interface Screen {
  readonly name: string;
}

const screensProvider = (importName: string): Manifest => ({ importName, capabilities: { provides: ["screens"] } });
const screensConsumer = (importName: string): Manifest => ({ importName, capabilities: { consumes: ["screens"] } });

describe("capabilities", () => {
  it("answers and hears an implementation only once its provider's activation is verified", () => {
    const world = createWorld();
    const agenda = world.open(screensConsumer("agenda"));
    const calendar = world.open(screensProvider("calendar"));
    const key = agenda.context.capability<Screen>("screens");
    const heard: [Screen, string][] = [];
    agenda.context.capabilities.watch(key, (implementation, change) => heard.push([implementation, change]));
    const screen: Screen = { name: "calendar" };

    calendar.context.provide(calendar.context.capability<Screen>("screens"), screen);
    expect(agenda.context.capabilities.all(key)).toEqual([]);
    expect(heard).toEqual([]);

    expect(world.core.verifyActivation(calendar.plugin).status).toBe(Status.Ok);

    expect(heard).toEqual([[screen, "provide"]]);
    expect(heard[0]?.[0]).toBe(screen);
    const all = agenda.context.capabilities.all(key);
    expect(all).toHaveLength(1);
    expect(all[0]).toBe(screen);
  });

  it("hears an implementation leave when its provider is released", () => {
    const world = createWorld();
    const agenda = world.open(screensConsumer("agenda"));
    const calendar = world.open(screensProvider("calendar"));
    const heard: [Screen, string][] = [];
    agenda.context.capabilities.watch(agenda.context.capability<Screen>("screens"), (implementation, change) =>
      heard.push([implementation, change]),
    );
    const screen: Screen = { name: "calendar" };
    calendar.context.provide(calendar.context.capability<Screen>("screens"), screen);
    world.core.verifyActivation(calendar.plugin);

    world.core.releasePlugin(calendar.plugin);

    expect(heard).toEqual([
      [screen, "provide"],
      [screen, "withdraw"],
    ]);
  });

  it("throws the core's refusal for a capability provided twice", () => {
    const world = createWorld();
    const calendar = world.open(screensProvider("calendar"));
    const key = calendar.context.capability<Screen>("screens");
    calendar.context.provide(key, { name: "first" });

    expect(() => calendar.context.provide(key, { name: "second" })).toThrow(RefusalError);
  });
});

describe("a listener that throws", () => {
  it("lets every other listener hear, reports the throw to the error sink, and reports no refusal", () => {
    const world = createWorld();
    const calendar = world.open(screensProvider("calendar"));
    const bad = world.open(screensConsumer("bad"));
    const agenda = world.open(screensConsumer("agenda"));
    const badHeard: [Screen, string][] = [];
    const agendaHeard: [Screen, string][] = [];
    bad.context.capabilities.watch(bad.context.capability<Screen>("screens"), (implementation, change) => {
      badHeard.push([implementation, change]);
      throw new Error("bad listener");
    });
    agenda.context.capabilities.watch(agenda.context.capability<Screen>("screens"), (implementation, change) =>
      agendaHeard.push([implementation, change]),
    );
    const screen: Screen = { name: "calendar" };

    calendar.context.provide(calendar.context.capability<Screen>("screens"), screen);
    world.core.verifyActivation(calendar.plugin);

    expect(agendaHeard).toEqual([[screen, "provide"]]);
    expect(badHeard).toEqual([[screen, "provide"]]);
    expect(world.dispatched.filter((event) => event.kind === "refusal" || event.kind === "reach-refused")).toEqual([]);
    expect(world.sunk.map((sunk) => (sunk.error as Error).message)).toEqual(["bad listener"]);
    expect(bad.log.entries).toEqual([]);
    expect(agenda.log.entries).toEqual([]);
    expect(world.hostLog.entries).toEqual([]);
  });

  it("keeps the other listeners of a service watch hearing too", () => {
    const world = createWorld();
    const alpha = world.open(provider);
    const bad = world.open(consumer("bad"));
    const beta = world.open(consumer("beta"));
    const betaHeard: string[] = [];
    bad.context.services.watch(bad.context.service(greetingId), () => {
      throw new Error("bad listener");
    });
    beta.context.services.watch(beta.context.service(greetingId), (_service, change) => betaHeard.push(change));

    const unregister = alpha.context.services.register(alpha.context.service(greetingId), greeting());
    unregister();

    expect(betaHeard).toEqual(["register", "unregister"]);
    expect(world.sunk).toHaveLength(2);
  });
});

describe("a registration ended while its events still wait", () => {
  const otherId = "alpha:other";
  const alphaWithOther: Manifest = { importName: "alpha", services: { provides: [{ id: greetingId }, { id: otherId }] } };

  it("still hands its object to a want settled before a listener unregistered it, then revokes it", async () => {
    const world = createWorld();
    const alpha = world.open(alphaWithOther);
    const gamma = world.open(consumer("gamma", greetingId, otherId));
    const service = greeting();
    const unregister = alpha.context.services.register(alpha.context.service<Greeting>(greetingId), service);
    let wanted = track(Promise.resolve<Greeting | undefined>(undefined));
    gamma.context.services.watch(gamma.context.service(otherId), () => {
      wanted = track(gamma.context.services.want(gamma.context.service<Greeting>(greetingId)));
      unregister();
      unregister();
    });
    const gammaHeard: PluginEvent[] = [];
    gamma.context.events.listen((event) => gammaHeard.push(event));

    alpha.context.services.register(alpha.context.service(otherId), {});
    await settle();

    expect(wanted.value).toBe(service);
    expect(gammaHeard).toEqual([{ kind: "revoked", reach: ReachKind.Service, id: greetingId, implementation: service }]);
    expect(world.dispatched.filter((event) => event.kind === "refusal")).toEqual([]);
    expect(world.contexts.tracked(alpha.plugin)).toBe(1);
  });

  it("does so too when the listener runs inside the core's own dispatch", async () => {
    const world = createWorld();
    const alpha = world.open(provider);
    const calendar = world.open(screensProvider("calendar"));
    const gamma = world.open({ importName: "gamma", services: { consumes: [{ id: greetingId }] }, capabilities: { consumes: ["screens"] } });
    const service = greeting();
    const unregister = alpha.context.services.register(alpha.context.service<Greeting>(greetingId), service);
    let wanted = track(Promise.resolve<Greeting | undefined>(undefined));
    gamma.context.capabilities.watch(gamma.context.capability("screens"), () => {
      wanted = track(gamma.context.services.want(gamma.context.service<Greeting>(greetingId)));
      unregister();
    });
    calendar.context.provide(calendar.context.capability("screens"), {});

    world.core.verifyActivation(calendar.plugin);
    await settle();

    expect(wanted.value).toBe(service);
    expect(world.contexts.tracked(alpha.plugin)).toBe(0);
  });
});

describe("the handles a context tracks", () => {
  it("stay bounded across many wants, registrations and watches", async () => {
    const world = createWorld();
    const alpha = world.open(provider);
    const beta = world.open(consumer("beta"));
    const key = alpha.context.service<Greeting>(greetingId);

    for (let round = 0; round < 20; round += 1) {
      const wanted = beta.context.services.want(beta.context.service<Greeting>(greetingId));
      const unregister = alpha.context.services.register(key, greeting());
      await wanted;
      const stop = beta.context.services.watch(beta.context.service(greetingId), () => {});
      stop();
      unregister();
    }

    expect(world.contexts.tracked(alpha.plugin)).toBe(0);
    expect(world.contexts.tracked(beta.plugin)).toBe(0);
  });
});

describe("a plugin the core stopped", () => {
  it("leaves a registration disposer that asks the core nothing, and its entries cleared", () => {
    const world = createWorld();
    const alpha = world.open(provider);
    const unregister = alpha.context.services.register(alpha.context.service(greetingId), greeting());
    alpha.context.services.watch(alpha.context.service(greetingId), () => {});
    world.core.releasePlugin(alpha.plugin);
    world.contexts.stopped(alpha.plugin);
    const refusalsBefore = world.dispatched.filter((event) => event.kind === "refusal").length;

    unregister();

    expect(world.dispatched.filter((event) => event.kind === "refusal")).toHaveLength(refusalsBefore);
    expect(world.contexts.tracked(alpha.plugin)).toBe(0);
  });
});

describe("an event drained before a context was made", () => {
  it("never reaches it, though it names the plugin's handle", () => {
    const world = createWorld();
    const heard: PluginEvent[] = [];
    let opened = false;
    world.core.setDispatcher((event) => {
      if (!opened) {
        opened = true;
        const plugin = openPlugin(world.core, consumer("beta"));
        world.core.getService(plugin, "nobody:thing");
        const context = world.contexts.create(plugin, consumer("beta"), recordingLogger().logger);
        context.events.listen((pluginEvent) => heard.push(pluginEvent));
      }
      world.dispatched.push(event);
      world.contexts.receive(event);
    });

    world.core.registerService(HOST, "");

    expect(world.dispatched.some((event) => event.kind === "reach-refused")).toBe(true);
    expect(heard).toEqual([]);
  });
});

describe("a context whose plugin the core has forgotten", () => {
  function forgotten() {
    const world = createWorld();
    const beta = world.open({ ...consumer("beta"), capabilities: { provides: ["screens"], consumes: ["screens"] } });
    world.core.releasePlugin(beta.plugin);
    world.contexts.stopped(beta.plugin);
    world.core.forgetPlugin(beta.plugin);
    world.contexts.forget(beta.plugin);
    const coreCalls = [
      vi.spyOn(world.core, "getService"),
      vi.spyOn(world.core, "serviceIds"),
      vi.spyOn(world.core, "registerService"),
      vi.spyOn(world.core, "wantService"),
      vi.spyOn(world.core, "watchService"),
      vi.spyOn(world.core, "allCapabilities"),
      vi.spyOn(world.core, "watchCapability"),
      vi.spyOn(world.core, "provideCapability"),
    ];
    return { context: beta.context, coreCalls };
  }

  it("answers every call that would reach the core as detached, a DetachedError and no refusal, reaching nothing", async () => {
    const { context, coreCalls } = forgotten();
    const greetingType = context.service<Greeting>(greetingId);
    const screens = context.capability<Screen>("screens");

    const thrown = [
      () => context.services.get(greetingType),
      () => context.services.ids(),
      () => context.services.register(greetingType, greeting()),
      () => context.services.watch(greetingType, () => {}),
      () => context.capabilities.all(screens),
      () => context.capabilities.watch(screens, () => {}),
      () => context.provide(screens, { name: "calendar" }),
    ].map((call) => {
      try {
        call();
        return undefined;
      } catch (error) {
        return error;
      }
    });
    const rejected = await context.services.want(greetingType).catch((reason: unknown) => reason);

    for (const answer of [...thrown, rejected]) {
      expect(answer).toBeInstanceOf(DetachedError);
      expect(answer).not.toBeInstanceOf(RefusalError);
    }
    for (const call of coreCalls) {
      expect(call).not.toHaveBeenCalled();
    }
  });

  it("still answers its manifest and its log", () => {
    const { context } = forgotten();

    expect(context.manifest.importName).toBe("beta");
    expect(() => context.log.info("still here")).not.toThrow();
  });
});

describe("revocation", () => {
  it("drops the held object when the core revokes it, tells the plugin, and later gets answer absent", () => {
    const world = createWorld();
    const alpha = world.open(provider);
    const beta = world.open(consumer("beta"));
    const service = greeting();
    alpha.context.services.register(alpha.context.service<Greeting>(greetingId), service);
    const key = beta.context.service<Greeting>(greetingId);
    expect(beta.context.services.get(key)).toBe(service);
    const registration = world.core.getService(HOST, greetingId).value ?? 0n;
    expect(world.contexts.held(beta.plugin, registration)).toBe(service);
    const heard: PluginEvent[] = [];
    beta.context.events.listen((event) => heard.push(event));

    world.core.releasePlugin(alpha.plugin);

    expect(world.contexts.held(beta.plugin, registration)).toBeUndefined();
    expect(heard).toEqual([{ kind: "revoked", reach: ReachKind.Service, id: greetingId, implementation: service }]);
    expect(beta.context.services.get(key)).toBeUndefined();
  });
});

describe("log", () => {
  it("forwards to the logger the host gave the plugin", () => {
    const world = createWorld();
    const alpha = world.open(provider);

    alpha.context.log.info("ready");
    alpha.context.log.error("failed", "because");

    expect(alpha.log.entries).toEqual([
      { level: "info", message: "ready" },
      { level: "error", message: "failed", cause: "because" },
    ]);
    expect(alpha.context.manifest).toBe(provider);
  });
});

describe("a constrained want", () => {
  const storeId = "alpha:store";
  const vocabulary = { constraintVocabulary: [{ constraintName: "minimumReplicas", attributeName: "replicas", bound: Bound.Lower }] };
  const storeProvider: Manifest = {
    importName: "alpha",
    services: { provides: [{ id: storeId, attributes: [{ name: "replicas", value: 1 }] }] },
  };
  const storeConsumer: Manifest = {
    importName: "beta",
    services: { consumes: [{ id: storeId, constraints: [{ name: "minimumReplicas", value: 3 }] }] },
  };

  it("asks the provider's object for its live attributes and whether it serves, then settles with it", async () => {
    const world = createWorld(vocabulary);
    const alpha = world.open(storeProvider);
    const beta = world.open(storeConsumer);
    const asked: Record<string, number>[] = [];
    let replicas = 1;
    const store = {
      attributes: () => ({ replicas }),
      serves: (constraints: Record<string, number>) => {
        asked.push(constraints);
        return true;
      },
    };
    alpha.context.services.register(alpha.context.service(storeId), store, { capacity: store });

    const wanted = track(beta.context.services.want(beta.context.service<typeof store>(storeId), { pollMillis: 100 }));
    await settle();
    expect(wanted.settled).toBe(false);
    expect(asked).toEqual([]);

    replicas = 3;
    world.clock.time = 100;
    world.core.advance(100);
    await settle();

    expect(asked).toEqual([{ minimumReplicas: 3 }]);
    expect(wanted.value).toBe(store);
  });

  it("asks nothing of an object registered without a capacity provider, so its advertised attributes stand", async () => {
    const world = createWorld(vocabulary);
    const alpha = world.open(storeProvider);
    const beta = world.open(storeConsumer);
    let asked = 0;
    const store = {
      attributes: () => {
        asked += 1;
        return { replicas: 3 };
      },
    };
    alpha.context.services.register(alpha.context.service(storeId), store);

    const wanted = track(beta.context.services.want(beta.context.service(storeId), { pollMillis: 100 }));
    world.clock.time = 100;
    world.core.advance(100);
    await settle();

    expect(asked).toBe(0);
    expect(wanted.settled).toBe(false);
  });

  it("is not served while the provider answers no", async () => {
    const world = createWorld(vocabulary);
    const alpha = world.open(storeProvider);
    const beta = world.open(storeConsumer);
    let serving = false;
    const store = { attributes: () => ({ replicas: 5 }), serves: () => serving };
    alpha.context.services.register(alpha.context.service(storeId), store, { capacity: store });

    const wanted = track(beta.context.services.want(beta.context.service(storeId), { pollMillis: 100 }));
    await settle();
    expect(wanted.settled).toBe(false);

    serving = true;
    world.clock.time = 100;
    world.core.advance(100);
    await settle();
    expect(wanted.value).toBe(store);
  });

  it("answers at the clock's time after the provider answered, so an answer later than its poll counts for nothing", async () => {
    const world = createWorld(vocabulary);
    const alpha = world.open(storeProvider);
    const beta = world.open(storeConsumer);
    const store = {
      attributes: () => {
        world.clock.time += 150;
        return { replicas: 3 };
      },
    };
    alpha.context.services.register(alpha.context.service(storeId), store, { capacity: store });

    const wanted = track(beta.context.services.want(beta.context.service(storeId), { pollMillis: 100 }));
    await settle();

    expect(wanted.settled).toBe(false);
  });

  it("reports a provider's throw to the error sink and leaves the question unanswered", async () => {
    const world = createWorld(vocabulary);
    const alpha = world.open(storeProvider);
    const beta = world.open(storeConsumer);
    let throwing = true;
    const store = {
      attributes: () => {
        if (throwing) {
          throw new Error("no capacity yet");
        }
        return { replicas: 3 };
      },
    };
    alpha.context.services.register(alpha.context.service(storeId), store, { capacity: store });

    const wanted = track(beta.context.services.want(beta.context.service(storeId), { pollMillis: 100 }));
    await settle();
    expect(wanted.settled).toBe(false);
    expect(world.sunk.map((sunk) => (sunk.error as Error).message)).toEqual(["no capacity yet"]);
    expect(alpha.log.entries).toEqual([]);
    expect(beta.log.entries).toEqual([]);

    throwing = false;
    world.clock.time = 100;
    world.core.advance(100);
    await settle();
    expect(wanted.value).toBe(store);
  });

  it("leaves a question that arrived incomplete unanswered, never putting it to the answerer", async () => {
    const world = createWorld(vocabulary);
    const alpha = world.open(storeProvider);
    const beta = world.open(storeConsumer);
    let asked = 0;
    const store = {
      attributes: () => {
        asked += 1;
        return { replicas: 1 };
      },
    };
    alpha.context.services.register(alpha.context.service(storeId), store, { capacity: store });
    track(beta.context.services.want(beta.context.service(storeId), { pollMillis: 100 }));
    await settle();
    const question = world.dispatched.find((event) => event.kind === "capacity-wanted");
    const askedBefore = asked;
    const reports = vi.spyOn(world.core, "reportCapacity");

    world.contexts.receive({ ...question!, constraints: [], incomplete: true } as CoreEvent);

    expect(question).toBeDefined();
    expect(asked).toBe(askedBefore);
    expect(reports).not.toHaveBeenCalled();
  });

  it("reports to the error sink a capacity answer the core would not take, leaving the question unanswered", async () => {
    const world = createWorld(vocabulary);
    const alpha = world.open(storeProvider);
    const beta = world.open(storeConsumer);
    const store = { attributes: () => ({ replicas: 3 }) };
    alpha.context.services.register(alpha.context.service(storeId), store, { capacity: store });
    vi.spyOn(world.core, "reportCapacity").mockReturnValue({ status: Status.Malformed, events: [], value: undefined });

    const wanted = track(beta.context.services.want(beta.context.service(storeId), { pollMillis: 100 }));
    await settle();

    expect(wanted.settled).toBe(false);
    expect(world.sunk).toHaveLength(1);
    expect(String(world.sunk[0]!.error)).toContain("weivel_report_capacity");
  });

  it("is refused by the core when asked without a poll interval, rejected with the refusal as data", async () => {
    const world = createWorld(vocabulary);
    world.open(storeProvider);
    const beta = world.open(storeConsumer);

    const rejection = await beta.context.services.want(beta.context.service(storeId)).catch((reason: unknown) => reason);

    expect(rejection).toBeInstanceOf(RefusalError);
    expect(rejection).toMatchObject({ code: RefusalCode.MalformedCall, hasFix: true });
  });
});
