import { afterEach, describe, expect, it } from "vitest";
import { isPluginError, isServiceRevoked, proxyHandles, ServiceHub } from "../../src/engine/index.js";
import type { Recorder, ServiceHubOptions } from "../../src/engine/index.js";
import { ManualScheduler } from "../../src/conformance/manual-scheduler.js";

interface Settled {
  state: "pending" | "settled" | "rejected";
  value?: unknown;
  reason?: unknown;
}

function track(promise: Promise<unknown>): Settled {
  const settled: Settled = { state: "pending" };
  promise.then(
    (value) => Object.assign(settled, { state: "settled", value }),
    (reason) => Object.assign(settled, { state: "rejected", reason }),
  );
  return settled;
}

function turn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function hubWith(options: Partial<ServiceHubOptions> = {}): { hub: ServiceHub; clock: ManualScheduler; reported: string[] } {
  const clock = new ManualScheduler();
  const reported: string[] = [];
  const hub = new ServiceHub({
    scheduler: clock,
    diagnostics: (message) => reported.push(message),
    handles: proxyHandles((message) => reported.push(message)),
    ...options,
  });
  return { hub, clock, reported };
}

function refusalOf(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("ServiceHub want", () => {
  const unhandled: unknown[] = [];
  const listen = (reason: unknown): void => {
    unhandled.push(reason);
  };

  afterEach(() => {
    process.off("unhandledRejection", listen);
    unhandled.length = 0;
  });

  it("raises no unhandled rejection when a dropped want is rejected by release", async () => {
    process.on("unhandledRejection", listen);
    const { hub } = hubWith();
    void hub.forConsumer("a").want("b:z");
    hub.release("a");
    await turn();
    expect(unhandled).toEqual([]);
  });

  it("is still pending an hour later when no timeout was asked for", async () => {
    const { hub, clock } = hubWith();
    const asked = track(hub.forConsumer("a").want("b:z"));
    clock.advanceTo(3_600_000);
    await turn();
    expect(asked.state).toBe("pending");
  });

  it("rejects with a refusal when the asked timeout elapses", async () => {
    const { hub, clock } = hubWith();
    const asked = track(hub.forConsumer("a").want("b:z", 1000));
    clock.advanceTo(999);
    await turn();
    expect(asked.state).toBe("pending");
    clock.advanceTo(1000);
    await turn();
    expect(asked.state).toBe("rejected");
    expect(isPluginError(asked.reason)).toBe(true);
  });

  it("settles with the handle a lookup returns when the provider arrives later", async () => {
    const { hub } = hubWith();
    const asked = track(hub.forConsumer("a").want("b:z"));
    hub.forConsumer("b").register("b:z", { name: () => "z" });
    await turn();
    expect(asked.state).toBe("settled");
    expect(asked.value).toBe(hub.get("b:z"));
  });

  it("settles at once when the service is already registered", async () => {
    const { hub } = hubWith();
    hub.forConsumer("b").register("b:z", { name: () => "z" });
    await expect(hub.forConsumer("a").want("b:z")).resolves.toBe(hub.get("b:z"));
  });
});

describe("ServiceHub register", () => {
  it("refuses an id outside the plugin's namespace, naming the one it should use", () => {
    const { hub } = hubWith();
    const refusal = refusalOf(() => hub.forConsumer("a").register("b:x", {}));
    expect(isPluginError(refusal)).toBe(true);
    expect((refusal as { fix: string }).fix).toContain("a:x");
    expect(hub.ids()).toEqual([]);
  });

  it("refuses a bare id unless it is well-known", () => {
    const { hub } = hubWith({ wellKnown: ["accounts"] });
    expect(isPluginError(refusalOf(() => hub.forConsumer("a").register("routing", {})))).toBe(true);
    hub.forConsumer("a").register("accounts", {});
    expect(hub.ids()).toEqual(["accounts"]);
  });

  it("refuses a second registration of the same id", () => {
    const { hub } = hubWith({ wellKnown: ["accounts"] });
    hub.forConsumer("a").register("accounts", {});
    expect(isPluginError(refusalOf(() => hub.forConsumer("b").register("accounts", {})))).toBe(true);
  });

  it("hands out one handle per served instance", () => {
    const { hub } = hubWith();
    hub.forConsumer("a").register("a:x", { name: () => "x" });
    expect(hub.get("a:x")).toBe(hub.forConsumer("b").get("a:x"));
  });

  it("unregisters and revokes through the returned disposer", () => {
    const { hub } = hubWith();
    const unregister = hub.forConsumer("a").register("a:x", { name: () => "x" });
    const held = hub.get("a:x") as { name(): string };
    unregister();
    expect(hub.get("a:x")).toBeUndefined();
    expect(isServiceRevoked(refusalOf(() => held.name()))).toBe(true);
  });

  it("does not let a stale disposer remove a later registration of the same id", () => {
    const { hub } = hubWith();
    const first = hub.forConsumer("a").register("a:x", { name: () => "first" });
    first();
    hub.forConsumer("a").register("a:x", { name: () => "second" });
    first();
    expect((hub.get("a:x") as { name(): string }).name()).toBe("second");
  });

  it("records who provides and who consumes", () => {
    const events: string[] = [];
    const recorder: Recorder = {
      provided: (pluginId, serviceId) => events.push(`provided ${pluginId} ${serviceId}`),
      consumed: (pluginId, serviceId) => events.push(`consumed ${pluginId} ${serviceId}`),
    };
    const { hub } = hubWith({ recorder });
    hub.forConsumer("a").register("a:x", {});
    hub.forConsumer("b").get("a:x");
    hub.get("a:x");
    expect(events).toEqual(["provided a a:x", "consumed b a:x"]);
  });
});

describe("ServiceHub watch", () => {
  it("reports a watcher that throws and still tells the others", () => {
    const { hub, reported } = hubWith();
    const heard: string[] = [];
    hub.forConsumer("b").watch("a:x", () => {
      throw new Error("bad watcher");
    });
    hub.forConsumer("c").watch("a:x", (_service, event) => heard.push(event));
    const unregister = hub.forConsumer("a").register("a:x", {});
    unregister();
    expect(heard).toEqual(["register", "unregister"]);
    expect(reported.filter((message) => message.includes("bad watcher"))).toHaveLength(2);
  });

  it("hands a watcher the same handle a lookup returns", () => {
    const { hub } = hubWith();
    const heard: unknown[] = [];
    hub.forConsumer("b").watch("a:x", (service) => heard.push(service));
    hub.forConsumer("a").register("a:x", {});
    expect(heard).toEqual([hub.get("a:x")]);
  });

  it("stops hearing once its disposer runs", () => {
    const { hub } = hubWith();
    const heard: string[] = [];
    const stop = hub.forConsumer("b").watch("a:x", (_service, event) => heard.push(event));
    stop();
    stop();
    hub.forConsumer("a").register("a:x", {});
    expect(heard).toEqual([]);
  });
});

describe("ServiceHub release", () => {
  it("unregisters exactly what the consumer registered, revoking what it served", () => {
    const { hub } = hubWith();
    hub.forConsumer("a").register("a:x", { name: () => "x" });
    hub.forConsumer("b").register("b:y", { name: () => "y" });
    const held = hub.get("a:x") as { name(): string };
    hub.release("a");
    expect(hub.ids()).toEqual(["b:y"]);
    expect(isServiceRevoked(refusalOf(() => held.name()))).toBe(true);
  });

  it("rejects what the consumer still waits for and leaves another's waits pending", async () => {
    const { hub } = hubWith();
    const mine = track(hub.forConsumer("a").want("c:z"));
    const theirs = track(hub.forConsumer("b").want("c:z"));
    hub.release("a");
    await turn();
    expect(mine.state).toBe("rejected");
    expect(isPluginError(mine.reason)).toBe(true);
    expect((mine.reason as { detail: string }).detail).toContain("stopped while waiting");
    expect(theirs.state).toBe("pending");
  });

  it("stops the consumer's watchers", () => {
    const { hub } = hubWith();
    const heard: string[] = [];
    hub.forConsumer("b").watch("a:x", (_service, event) => heard.push(event));
    hub.release("b");
    hub.forConsumer("a").register("a:x", {});
    expect(heard).toEqual([]);
  });

  it("cancels the timer of a want it rejects", async () => {
    const { hub, clock } = hubWith();
    const asked = track(hub.forConsumer("a").want("c:z", 1000));
    hub.release("a");
    clock.advanceTo(5000);
    await turn();
    expect((asked.reason as { detail: string }).detail).toContain("stopped while waiting");
  });
});

describe("ServiceHub hostService", () => {
  it("is exempt from namespacing and survives every consumer's release", () => {
    const { hub } = hubWith();
    hub.hostService("clock", { now: () => 0 });
    hub.release("");
    hub.release("a");
    expect(hub.ids()).toEqual(["clock"]);
  });

  it("revokes the handles over the instance it replaces", () => {
    const { hub } = hubWith();
    hub.hostService("clock", { now: () => 0 });
    const held = hub.get("clock") as { now(): number };
    hub.hostService("clock", { now: () => 1 });
    expect(isServiceRevoked(refusalOf(() => held.now()))).toBe(true);
    expect((hub.get("clock") as { now(): number }).now()).toBe(1);
  });

  it("settles a want waiting for it", async () => {
    const { hub } = hubWith();
    const asked = track(hub.forConsumer("a").want("clock"));
    hub.hostService("clock", { now: () => 0 });
    await turn();
    expect(asked.state).toBe("settled");
  });
});

describe("ServiceHub defaults", () => {
  it("reports through the unwrapped default when a served service is withdrawn", () => {
    const reported: string[] = [];
    const hub = new ServiceHub({ scheduler: new ManualScheduler(), diagnostics: (message) => reported.push(message) });
    const service = {};
    const unregister = hub.forConsumer("a").register("a:x", service);
    expect(hub.get("a:x")).toBe(service);
    unregister();
    expect(reported).toHaveLength(1);
  });
});
