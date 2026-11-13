import { join } from "node:path";
import koffi from "koffi";
import { describe, expect, it } from "vitest";
import { copyEvent, eventKindAt } from "../../src/core/events.ts";
import { readGrowingElements } from "../../src/core/memory.ts";
import {
  Axis,
  Change,
  Choice,
  coreStructs,
  createCore,
  EdgeSource,
  HOST,
  loadCoreLibrary,
  offsetOf,
  PluginStatus,
  RefusalCode,
  sizeOf,
  Status,
  type CoreEvent,
} from "../../src/core/index.ts";
import { coreLibraryPath, createRecordedCore, openPlugin } from "../real-core.ts";

const provider = { importName: "alpha", services: { provides: [{ id: "alpha:greeting" }] } };
const consumer = (importName: string) => ({ importName, services: { consumes: [{ id: "alpha:greeting" }] } });

describe("loading the core", () => {
  it("loads the library from the path it is given", () => {
    expect(loadCoreLibrary(coreLibraryPath).path).toBe(coreLibraryPath);
  });

  it("refuses a path with no library, naming the path", () => {
    const missing = join(import.meta.dirname, "no-such-directory", "weivel_core.dll");
    expect(() => loadCoreLibrary(missing)).toThrow(`The weivel core library is not at ${missing}`);
  });

  it("answers the core's own status when the options are malformed, and no core", () => {
    const created = createCore({ libraryPath: coreLibraryPath, options: { initialEventCapacity: 65537 } });
    expect(created.status).toBe(Status.Malformed);
    expect(created.value).toBeUndefined();
  });
});

describe("every bound call", () => {
  it("answers a malformed call's status with the refusal drained after it", () => {
    const { core, dispatched } = createRecordedCore();

    const answer = core.registerService(HOST, "");

    expect(answer.status).toBe(Status.Malformed);
    expect(answer.events).toHaveLength(1);
    const [event] = answer.events;
    expect(event?.kind).toBe("refusal");
    if (event?.kind === "refusal") {
      expect(event.refusal.code).toBe(RefusalCode.MalformedCall);
      expect(typeof event.refusal.detail).toBe("string");
      expect(event.refusal.detail).not.toBe("");
    }
    expect(dispatched).toEqual(answer.events);
  });

  it("drains every event the call queued, in order, leaving none for the next call", () => {
    const { core, dispatched } = createRecordedCore();
    const alpha = openPlugin(core, provider);
    const beta = openPlugin(core, consumer("beta"));
    const gamma = openPlugin(core, consumer("gamma"));
    const registration = core.registerService(alpha, "alpha:greeting").value!;
    core.getService(beta, "alpha:greeting");
    core.getService(gamma, "alpha:greeting");
    const watch = core.watchService(beta, "alpha:greeting").value!;

    const unregistered = core.unregister(registration);

    expect(unregistered.status).toBe(Status.Ok);
    expect(unregistered.events).toEqual([
      { kind: "revoked", plugin: beta, implementation: registration },
      { kind: "revoked", plugin: gamma, implementation: registration },
      { kind: "watch", watch, plugin: beta, implementation: registration, change: Change.Unregistered },
    ]);
    expect(dispatched.slice(-3)).toEqual(unregistered.events);
    expect(core.nextDeadline().events).toEqual([]);
  });

  it("dispatches the events of a call the dispatcher makes after the event being dispatched", () => {
    const order: string[] = [];
    const { core } = createRecordedCore();
    core.setDispatcher((event) => {
      order.push(event.kind);
      if (order.length === 1) {
        const nested = core.registerService(HOST, "");
        order.push(`nested call answered ${nested.events.length} event`);
      }
    });

    core.registerService(HOST, "");

    expect(order).toEqual(["refusal", "nested call answered 1 event", "refusal"]);
  });

  it("dispatches a nested call's events after every event drained before them, first in, first out", () => {
    const { core } = createRecordedCore();
    const alpha = openPlugin(core, provider);
    const beta = openPlugin(core, consumer("beta"));
    const gamma = openPlugin(core, consumer("gamma"));
    const registration = core.registerService(alpha, "alpha:greeting").value!;
    core.getService(beta, "alpha:greeting");
    core.getService(gamma, "alpha:greeting");
    const order: string[] = [];
    core.setDispatcher((event) => {
      order.push(event.kind === "revoked" ? `revoked ${event.plugin === beta ? "beta" : "gamma"}` : event.kind);
      if (order.length === 1) {
        core.registerService(HOST, "");
      }
    });

    core.unregister(registration);

    expect(order).toEqual(["revoked beta", "revoked gamma", "refusal"]);
  });

  it("copies every string out, so an event outlives its release and its core", () => {
    const { core } = createRecordedCore();
    const answer = core.registerService(HOST, "");
    const detail = answer.events[0]?.kind === "refusal" ? answer.events[0].refusal.detail : undefined;
    core.destroy();

    expect(typeof detail).toBe("string");
    expect(answer.events[0]).toMatchObject({ refusal: { detail } });
  });

  it("refuses a call on a destroyed core instead of handing the core a dangling pointer", () => {
    const { core } = createRecordedCore();
    core.destroy();
    expect(() => core.nextDeadline()).toThrow("destroyed");
  });
});

describe("an event of a kind this layer does not know", () => {
  it("is read as nothing and still released", () => {
    const library = loadCoreLibrary(coreLibraryPath);
    const event = koffi.alloc(coreStructs.weivel_event, 1) as object;
    try {
      koffi.encode(event, 0, "uint32_t", sizeOf("weivel_event"));
      koffi.encode(event, offsetOf("weivel_event", "kind"), "uint32_t", 99);
      koffi.encode(event, offsetOf("weivel_event", "storage"), "void *", null);

      expect(copyEvent(event)).toBeUndefined();
      expect(library.functions.weivel_event_release(event)).toBe(Status.Ok);
      expect(eventKindAt(event)).toBe(0);
    } finally {
      koffi.free(event);
    }
  });
});

describe("answers", () => {
  it("are read back from the core with every refusal's subject", () => {
    const { core } = createRecordedCore({ options: { api: 1 } });

    const support = core.supports({ importName: "needs-more", api: 2 });

    expect(support.status).toBe(Status.Ok);
    expect(support.value).toEqual({
      supported: false,
      axis: Axis.Api,
      refusal: expect.objectContaining({ code: RefusalCode.Incompatible, subject: "needs-more", hasFix: true }),
    });
  });

  it("plan an activation as the core orders it", () => {
    const { core } = createRecordedCore();
    const beta = core.registerManifest(consumer("beta")).value!;
    const alpha = core.registerManifest(provider).value!;
    const lonely = core.registerManifest({
      importName: "lonely",
      services: { consumes: [{ id: "nobody:thing", optional: Choice.No }] },
    }).value!;

    const plan = core.planActivation([beta, alpha, lonely], EdgeSource.Services);

    expect(plan.status).toBe(Status.Ok);
    expect(plan.value?.order).toEqual([alpha, beta]);
    expect(plan.value?.edges).toEqual([{ provider: alpha, consumer: beta }]);
    expect(plan.value?.refusals).toEqual([
      { plugin: lonely, refusal: expect.objectContaining({ code: RefusalCode.UnmetNeed, subject: "nobody:thing" }) },
    ]);
  });

  it("read the ledger's rows and a single row", () => {
    const { core } = createRecordedCore();
    const alpha = openPlugin(core, { ...provider, permissions: ["read"] });
    core.registerService(alpha, "alpha:greeting");

    const ledger = core.ledger();
    const row = core.ledgerEntry(alpha);

    expect(ledger.value?.rows).toHaveLength(1);
    expect(row.value).toEqual(ledger.value?.rows[0]);
    expect(row.value).toMatchObject({
      plugin: alpha,
      importName: "alpha",
      status: PluginStatus.Active,
      permissions: ["read"],
      servicesProvided: ["alpha:greeting"],
    });
  });

  it("list capabilities from the core", () => {
    const { core } = createRecordedCore();
    const alpha = openPlugin(core, { importName: "alpha", capabilities: { provides: ["paint"] } });
    const implementation = core.provideCapability(alpha, "paint").value!;
    expect(core.verifyActivation(alpha).status).toBe(Status.Ok);

    expect(core.allCapabilities(HOST, "paint").value).toEqual([{ implementation, provider: alpha }]);
  });
});

describe("an array whose elements may grow", () => {
  it("is stepped by its first element's size, not by this layer's", () => {
    const newerStride = sizeOf("weivel_capability_implementation") + 16;
    const items = koffi.alloc("uint8_t", newerStride * 2) as object;
    try {
      for (const [index, handle] of [7n, 9n].entries()) {
        koffi.encode(items, index * newerStride, coreStructs.weivel_capability_implementation, {
          size: newerStride,
          implementation: handle,
          provider: handle + 1n,
        });
      }

      const read = readGrowingElements(items, 2, "weivel_capability_implementation").map((element) =>
        BigInt(element.implementation as number),
      );

      expect(read).toEqual([7n, 9n]);
    } finally {
      koffi.free(items);
    }
  });
});

describe("a handle", () => {
  it("stays a bigint end to end, the host's included", () => {
    const { core } = createRecordedCore();
    const registration = core.registerService(HOST, "shared");
    expect(typeof registration.value).toBe("bigint");
    expect(core.getService(HOST, "shared").value).toBe(registration.value);
    const events: CoreEvent[] = [...core.unregister(registration.value!).events];
    expect(events).toEqual([{ kind: "revoked", plugin: HOST, implementation: registration.value }]);
  });
});
