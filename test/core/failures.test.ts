import koffi from "koffi";
import { afterEach, describe, expect, it } from "vitest";
import { drainEvents, readThenRelease } from "../../src/core/core.ts";
import { copyEvent } from "../../src/core/events.ts";
import {
  Choice,
  Core,
  coreStructs,
  HOST,
  loadCoreLibrary,
  offsetOf,
  RefusalCode,
  sizeOf,
  Status,
  type CoreEvent,
  type CoreFunctions,
} from "../../src/core/index.ts";
import { CoreTimer, type Scheduler } from "../../src/timer/index.ts";
import { coreLibraryPath, createRecordedCore, openPlugin } from "../real-core.ts";

const library = loadCoreLibrary(coreLibraryPath);
const rawCores: object[] = [];
const coresToDestroy: Core[] = [];

afterEach(() => {
  for (const core of coresToDestroy.splice(0)) {
    core.destroy();
  }
  for (const core of rawCores.splice(0)) {
    library.functions.weivel_core_destroy(core);
  }
});

interface SinkRecord {
  readonly error: unknown;
  readonly event: CoreEvent | undefined;
}

function createRawCore(): object {
  const created: unknown[] = [null];
  expect(library.functions.weivel_core_create(null, created, null)).toBe(Status.Ok);
  return created[0] as object;
}

/** A real core bound through the real functions, some of them wrapped by `overrides`. */
function createWrappedCore(overrides: Partial<CoreFunctions>) {
  const sunk: SinkRecord[] = [];
  const dispatched: CoreEvent[] = [];
  const core = new Core({ ...library.functions, ...overrides }, createRawCore(), (error, event) =>
    sunk.push({ error, event }),
  );
  core.setDispatcher((event) => dispatched.push(event));
  coresToDestroy.push(core);
  return { core, sunk, dispatched };
}

function queueMalformedRefusal(core: object): void {
  expect(library.functions.weivel_register_service(core, HOST, "", [0], null)).toBe(Status.Malformed);
}

describe("an answer whose read throws", () => {
  it("is released all the same", () => {
    const answer = koffi.alloc(coreStructs.weivel_service_list, 1) as object;
    koffi.encode(answer, 0, coreStructs.weivel_service_list, { size: sizeOf("weivel_service_list") });
    let releases = 0;
    try {
      expect(() =>
        readThenRelease(
          answer,
          () => {
            throw new Error("unreadable");
          },
          (released) => {
            releases += 1;
            return library.functions.weivel_service_list_release(released);
          },
        ),
      ).toThrow("unreadable");
      expect(releases).toBe(1);
    } finally {
      koffi.free(answer);
    }
  });
});

describe("a call that throws", () => {
  it("still drains its own events, leaving none for the next call", () => {
    const { core, dispatched } = createWrappedCore({
      weivel_register_service: (...parameters: unknown[]) => {
        library.functions.weivel_register_service(...parameters);
        throw new Error("thrown after the call");
      },
    });

    expect(() => core.registerService(HOST, "")).toThrow("thrown after the call");

    expect(dispatched).toEqual([expect.objectContaining({ kind: "refusal" })]);
    expect(core.nextDeadline().events).toEqual([]);
  });
});

describe("a dispatcher that throws", () => {
  it("never costs the caller its answer, and every event is still dispatched", () => {
    const sunk: SinkRecord[] = [];
    const { core } = createRecordedCore({ onListenerError: (error, event) => sunk.push({ error, event }) });
    const alpha = openPlugin(core, { importName: "alpha", services: { provides: [{ id: "alpha:greeting" }] } });
    const beta = openPlugin(core, { importName: "beta", services: { consumes: [{ id: "alpha:greeting" }] } });
    const gamma = openPlugin(core, { importName: "gamma", services: { consumes: [{ id: "alpha:greeting" }] } });
    const registration = core.registerService(alpha, "alpha:greeting").value!;
    core.getService(beta, "alpha:greeting");
    core.getService(gamma, "alpha:greeting");
    const seen: CoreEvent[] = [];
    const failure = new Error("listener failed");
    core.setDispatcher((event) => {
      seen.push(event);
      if (seen.length === 1) {
        throw failure;
      }
    });

    const unregistered = core.unregister(registration);

    expect(unregistered.status).toBe(Status.Ok);
    expect(seen).toEqual(unregistered.events);
    expect(seen).toHaveLength(2);
    expect(sunk).toEqual([{ error: failure, event: seen[0] }]);
  });

  it("nor does a drain listener that throws", () => {
    const sunk: SinkRecord[] = [];
    const { core } = createRecordedCore({ onListenerError: (error, event) => sunk.push({ error, event }) });
    const failure = new Error("drain listener failed");
    core.addDrainListener(() => {
      throw failure;
    });

    const registered = core.registerService(HOST, "shared");

    expect(registered.status).toBe(Status.Ok);
    expect(typeof registered.value).toBe("bigint");
    expect(sunk).toEqual([{ error: failure, event: undefined }]);
  });
});

describe("a timer-driven call that throws", () => {
  it("goes to the sink instead of out of the timer callback", () => {
    const failure = new Error("advance failed");
    const { core, sunk } = createWrappedCore({
      weivel_advance: () => {
        throw failure;
      },
    });
    const scheduled: (() => void)[] = [];
    const scheduler: Scheduler = { schedule: (callback) => scheduled.push(callback), cancel: () => undefined };
    new CoreTimer(core, { clock: { now: () => 0 }, scheduler });
    const beta = openPlugin(core, { importName: "beta", services: { consumes: [{ id: "alpha:greeting" }] } });
    core.wantService(beta, "alpha:greeting", { timed: Choice.Yes, now: 0, timeoutMillis: 10 });

    expect(() => scheduled.at(-1)!()).not.toThrow();
    expect(sunk).toEqual([{ error: failure, event: undefined }]);
  });
});

describe("draining", () => {
  it("releases an event it could not copy and drains the rest", () => {
    const core = createRawCore();
    rawCores.push(core);
    queueMalformedRefusal(core);
    queueMalformedRefusal(core);
    const eventBuffer = koffi.alloc(coreStructs.weivel_event, 1) as object;
    koffi.encode(eventBuffer, 0, coreStructs.weivel_event, { size: sizeOf("weivel_event") });
    const drained: CoreEvent[] = [];
    const reported: unknown[] = [];
    let copies = 0;
    try {
      drainEvents(
        library.functions,
        core,
        eventBuffer,
        drained,
        (event) => {
          copies += 1;
          if (copies === 1) {
            throw new Error("uncopyable");
          }
          return copyEvent(event);
        },
        (error) => reported.push(error),
      );

      expect(reported).toEqual([new Error("uncopyable")]);
      expect(drained).toEqual([
        expect.objectContaining({ kind: "refusal", refusal: expect.objectContaining({ code: RefusalCode.MalformedCall }) }),
      ]);
      expect(library.functions.weivel_next_event(core, eventBuffer, null)).toBe(Status.None);
    } finally {
      koffi.free(eventBuffer);
    }
  });

  it("releases and leaves out an event of a kind this layer does not know", () => {
    let injected = false;
    const { core, dispatched } = createWrappedCore({
      weivel_next_event: (...parameters: unknown[]) => {
        if (!injected) {
          injected = true;
          koffi.encode(parameters[1], offsetOf("weivel_event", "kind"), "uint32_t", 99);
          return Status.Ok;
        }
        return library.functions.weivel_next_event(...parameters);
      },
    });

    const answer = core.registerService(HOST, "");

    expect(answer.events).toEqual([expect.objectContaining({ kind: "refusal" })]);
    expect(dispatched).toEqual(answer.events);
  });
});
