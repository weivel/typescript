import koffi from "koffi";
import { afterEach, describe, expect, it } from "vitest";
import { drainEvents } from "../../src/core/core.ts";
import { copyEvent, copyIncompleteEvent, TEXT_NOT_COPIED } from "../../src/core/events.ts";
import {
  CapacityQuestion,
  Core,
  coreStructs,
  createCore,
  EventKind,
  HOST,
  loadCoreLibrary,
  offsetOf,
  RefusalCode,
  sizeOf,
  Status,
  type CoreEvent,
  type CoreFunctions,
} from "../../src/core/index.ts";
import { coreLibraryPath, openPlugin } from "../real-core.ts";

const library = loadCoreLibrary(coreLibraryPath);
const coresToDestroy: Core[] = [];
const rawCores: object[] = [];

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

/** A real core made through createCore, some of its functions wrapped by `overrides`, every event and sink recorded. */
function createWrappedCore(overrides: Partial<CoreFunctions>) {
  const sunk: SinkRecord[] = [];
  const dispatched: CoreEvent[] = [];
  const created = createCore({
    library: { path: library.path, functions: { ...library.functions, ...overrides } },
    dispatcher: (event) => dispatched.push(event),
    onListenerError: (error, event) => sunk.push({ error, event }),
  });
  if (created.value !== undefined) {
    coresToDestroy.push(created.value);
  }
  return { created, core: created.value!, sunk, dispatched };
}

function queueMalformedRefusal(core: object): void {
  expect(library.functions.weivel_register_service(core, HOST, "", [0], null)).toBe(Status.Malformed);
}

describe("the core's creation", () => {
  it("is drained as any call is, so a listener given at creation hears what it queued", () => {
    const { created, dispatched } = createWrappedCore({
      weivel_core_create: (...parameters: unknown[]) => {
        const status = library.functions.weivel_core_create(...parameters);
        const [, made, pending] = parameters as [unknown, unknown[], Uint32Array | null];
        queueMalformedRefusal(made[0] as object);
        if (pending !== null) {
          pending[0] = 1;
        }
        return status;
      },
    });

    expect(created.status).toBe(Status.Ok);
    expect(created.events).toEqual([expect.objectContaining({ kind: "refusal" })]);
    expect(dispatched).toEqual(created.events);
  });
});

function createRawCore(): object {
  const created: unknown[] = [null];
  expect(library.functions.weivel_core_create(null, created, null)).toBe(Status.Ok);
  rawCores.push(created[0] as object);
  return created[0] as object;
}

function withEventBuffer(use: (eventBuffer: object) => void): void {
  const eventBuffer = koffi.alloc(coreStructs.weivel_event, 1) as object;
  koffi.encode(eventBuffer, 0, coreStructs.weivel_event, { size: sizeOf("weivel_event") });
  try {
    use(eventBuffer);
  } finally {
    koffi.free(eventBuffer);
  }
}

const malformedRefusalNotCopied = {
  kind: "refusal",
  refusal: { code: RefusalCode.MalformedCall, detail: TEXT_NOT_COPIED, fix: TEXT_NOT_COPIED, subject: null, hasFix: true },
  incomplete: true,
};

describe("an event the layer cannot copy whole", () => {
  it("is still drained, marked incomplete with its codes exact and each text the layer's sentence, the sink told once", () => {
    const core = createRawCore();
    queueMalformedRefusal(core);
    queueMalformedRefusal(core);
    const drained: CoreEvent[] = [];
    const reported: SinkRecord[] = [];
    const failure = new Error("uncopyable");
    let copies = 0;
    withEventBuffer((eventBuffer) => {
      drainEvents(
        library.functions,
        core,
        eventBuffer,
        drained,
        (event) => {
          copies += 1;
          if (copies === 1) {
            throw failure;
          }
          return copyEvent(event);
        },
        copyIncompleteEvent,
        (error, event) => reported.push({ error, event }),
      );

      expect(drained).toEqual([
        malformedRefusalNotCopied,
        expect.objectContaining({ kind: "refusal", refusal: expect.objectContaining({ code: RefusalCode.MalformedCall }) }),
      ]);
      expect(drained[1]).not.toHaveProperty("incomplete");
      expect(reported).toEqual([{ error: failure, event: malformedRefusalNotCopied }]);
      expect(library.functions.weivel_next_event(core, eventBuffer, null)).toBe(Status.None);
    });
  });

  it("leaves a capacity question's constraints out, reading none of them, its handles exact", () => {
    const core = createRawCore();
    queueMalformedRefusal(core);
    withEventBuffer((eventBuffer) => {
      expect(library.functions.weivel_next_event(core, eventBuffer, null)).toBe(Status.Ok);
      rewriteIntoUnreadableQuestion(eventBuffer);

      expect(copyIncompleteEvent(eventBuffer)).toEqual({
        kind: "capacity-wanted",
        want: 7n,
        plugin: 8n,
        registration: 9n,
        request: 10n,
        question: CapacityQuestion.Serve,
        constraints: [],
        incomplete: true,
      });
      library.functions.weivel_event_release(eventBuffer);
    });
  });
});

/** Rewrites a drained event into a capacity question whose constraints point at nothing a layer may read. */
function rewriteIntoUnreadableQuestion(eventBuffer: object): void {
  const payload = offsetOf("weivel_event", "data");
  koffi.encode(eventBuffer, offsetOf("weivel_event", "kind"), "uint32_t", EventKind.CapacityWanted);
  koffi.encode(eventBuffer, payload, coreStructs.weivel_capacity_event, {
    want: 7,
    plugin: 8,
    registration: 9,
    request: 10,
    question: CapacityQuestion.Serve,
    constraints: { items: null, count: 3 },
  });
  koffi.encode(eventBuffer, payload + offsetOf("weivel_capacity_event", "constraints"), "uint64_t", 8);
}

describe("WEIVEL_STATUS_MALFORMED", () => {
  it("from weivel_next_event is a defect of the layer, reported to the sink and never thrown to the caller", () => {
    const { core, sunk } = createWrappedCore({ weivel_next_event: () => Status.Malformed });

    const answer = core.registerService(HOST, "");

    expect(answer.status).toBe(Status.Malformed);
    expect(sunk).toHaveLength(1);
    expect(String(sunk[0]!.error)).toContain("weivel_next_event");
  });

  it("from a call the layer built whole is a defect of the layer, reported to the sink once", () => {
    const { core, sunk } = createWrappedCore({ weivel_release_plugin: () => Status.Malformed });
    const plugin = openPlugin(core, { importName: "alpha" });

    const answer = core.releasePlugin(plugin);

    expect(answer.status).toBe(Status.Malformed);
    expect(sunk).toHaveLength(1);
    expect(String(sunk[0]!.error)).toContain("weivel_release_plugin");
  });

  it("from a call carrying what the caller built is answered with the core's refusal and reported to no sink", () => {
    const { core, sunk } = createWrappedCore({});

    const answer = core.registerService(HOST, "");

    expect(answer.status).toBe(Status.Malformed);
    expect(answer.events).toEqual([
      expect.objectContaining({ kind: "refusal", refusal: expect.objectContaining({ code: RefusalCode.MalformedCall }) }),
    ]);
    expect(sunk).toEqual([]);
  });
});
