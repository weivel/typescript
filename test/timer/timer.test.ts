import { afterEach, describe, expect, it } from "vitest";
import { Bound, Choice, createCore, HOST, loadCoreLibrary, RefusalCode, type Core, type CoreEvent } from "../../src/core/index.ts";
import { CoreTimer, systemClock, type Clock, type Scheduler } from "../../src/timer/index.ts";
import { coreLibraryPath, createRecordedCore, openPlugin } from "../real-core.ts";

class FakeClock implements Clock {
  current = 1000;
  now(): number {
    return this.current;
  }
}

interface Scheduled {
  readonly callback: () => void;
  readonly delayMilliseconds: number;
  cancelled: boolean;
  fired: boolean;
}

class FakeScheduler implements Scheduler {
  readonly scheduled: Scheduled[] = [];

  schedule(callback: () => void, delayMilliseconds: number): unknown {
    const entry: Scheduled = { callback, delayMilliseconds, cancelled: false, fired: false };
    this.scheduled.push(entry);
    return entry;
  }

  cancel(token: unknown): void {
    (token as Scheduled).cancelled = true;
  }

  live(): Scheduled[] {
    return this.scheduled.filter((entry) => !entry.cancelled && !entry.fired);
  }

  fireNext(): void {
    const [next] = this.live();
    if (next === undefined) {
      throw new Error("nothing is scheduled");
    }
    next.fired = true;
    next.callback();
  }
}

function waitingConsumer(core: Core): bigint {
  return openPlugin(core, { importName: "beta", services: { consumes: [{ id: "alpha:greeting" }] } });
}

function timedWant(core: Core, plugin: bigint, clock: FakeClock, timeoutMillis: number): bigint {
  return core.wantService(plugin, "alpha:greeting", { timed: Choice.Yes, now: clock.now(), timeoutMillis }).value!;
}

describe("the core timer", () => {
  it("arms nothing while the core waits on no time", () => {
    const { core } = createRecordedCore();
    const scheduler = new FakeScheduler();
    const timer = new CoreTimer(core, { clock: new FakeClock(), scheduler });

    expect(timer.armedDeadline).toBeUndefined();
    expect(scheduler.live()).toEqual([]);
  });

  it("arms the core's next deadline after the drain of the call that set it", () => {
    const { core } = createRecordedCore();
    const clock = new FakeClock();
    const scheduler = new FakeScheduler();
    const timer = new CoreTimer(core, { clock, scheduler });

    timedWant(core, waitingConsumer(core), clock, 250);

    expect(timer.armedDeadline).toBe(1250);
    expect(scheduler.live().map((entry) => entry.delayMilliseconds)).toEqual([250]);
  });

  it("advances the core when it fires, so the want times out, and arms nothing after", () => {
    const { core, dispatched } = createRecordedCore();
    const clock = new FakeClock();
    const scheduler = new FakeScheduler();
    const timer = new CoreTimer(core, { clock, scheduler });
    const want = timedWant(core, waitingConsumer(core), clock, 250);

    clock.current = 1250;
    scheduler.fireNext();

    expect(dispatched.filter((event) => event.kind === "want-settled").at(-1)).toMatchObject({ kind: "want-settled", want, refusal: { code: RefusalCode.TimedOut } });
    expect(timer.armedDeadline).toBeUndefined();
    expect(scheduler.live()).toEqual([]);
  });

  it("re-arms for the earlier deadline when a later call sets one", () => {
    const { core } = createRecordedCore();
    const clock = new FakeClock();
    const scheduler = new FakeScheduler();
    const timer = new CoreTimer(core, { clock, scheduler });
    const beta = waitingConsumer(core);
    timedWant(core, beta, clock, 500);

    timedWant(core, beta, clock, 100);

    expect(timer.armedDeadline).toBe(1100);
    expect(scheduler.live().map((entry) => entry.delayMilliseconds)).toEqual([100]);
  });

  it("cancels its timer when the core no longer waits on time", () => {
    const { core } = createRecordedCore();
    const clock = new FakeClock();
    const scheduler = new FakeScheduler();
    const timer = new CoreTimer(core, { clock, scheduler });
    const want = timedWant(core, waitingConsumer(core), clock, 250);

    core.unregister(want);

    expect(timer.armedDeadline).toBeUndefined();
    expect(scheduler.live()).toEqual([]);
  });

  it("stops re-arming once stopped", () => {
    const { core } = createRecordedCore();
    const clock = new FakeClock();
    const scheduler = new FakeScheduler();
    const timer = new CoreTimer(core, { clock, scheduler });
    timer.stop();

    timedWant(core, waitingConsumer(core), clock, 250);

    expect(scheduler.live()).toEqual([]);
  });
});

const countedCores: Core[] = [];

afterEach(() => {
  for (const core of countedCores.splice(0)) {
    core.destroy();
  }
});

/** A real core whose every weivel_next_deadline is counted: the timer must never ask it. */
function deadlineCountingCore(): { core: Core; deadlineQuestions: () => number } {
  const library = loadCoreLibrary(coreLibraryPath);
  let questions = 0;
  const functions = {
    ...library.functions,
    weivel_next_deadline: (...parameters: unknown[]) => {
      questions += 1;
      return library.functions.weivel_next_deadline(...parameters);
    },
  };
  const core = createCore({ library: { path: library.path, functions } }).value!;
  countedCores.push(core);
  return { core, deadlineQuestions: () => questions };
}

function provider(core: Core): bigint {
  return openPlugin(core, { importName: "alpha", services: { provides: [{ id: "alpha:greeting" }] } });
}

describe("re-arming", () => {
  it("arms from the core's announcements alone, never asking the core for its deadline", () => {
    const { core, deadlineQuestions } = deadlineCountingCore();
    const clock = new FakeClock();
    const scheduler = new FakeScheduler();
    const timer = new CoreTimer(core, { clock, scheduler });
    const beta = waitingConsumer(core);

    timedWant(core, beta, clock, 250);
    clock.current = 1250;
    scheduler.fireNext();

    expect(deadlineQuestions()).toBe(0);
    expect(timer.armedDeadline).toBeUndefined();
  });

  it("is armed by the time the events of the call that moved the deadline are dispatched", () => {
    const { core, dispatched } = createRecordedCore();
    const clock = new FakeClock();
    const timer = new CoreTimer(core, { clock, scheduler: new FakeScheduler() });
    const alpha = provider(core);
    const want = timedWant(core, waitingConsumer(core), clock, 250);
    const armedAtDispatch: (number | undefined)[] = [];
    core.setDispatcher((event) => {
      dispatched.push(event);
      if (event.kind === "want-settled") {
        armedAtDispatch.push(timer.armedDeadline);
      }
    });

    core.registerService(alpha, "alpha:greeting");

    expect(dispatched.at(-1)).toMatchObject({ kind: "deadline", at: undefined });
    expect(dispatched.find((event) => event.kind === "want-settled")).toMatchObject({ want });
    expect(armedAtDispatch).toEqual([undefined]);
  });

  it("arms for the latest announcement when calls made during a dispatch move the deadline", () => {
    const { core } = createRecordedCore();
    const clock = new FakeClock();
    const scheduler = new FakeScheduler();
    const timer = new CoreTimer(core, { clock, scheduler });
    const beta = waitingConsumer(core);
    let asked = false;
    core.setDispatcher(() => {
      if (!asked) {
        asked = true;
        timedWant(core, beta, clock, 300);
        timedWant(core, beta, clock, 100);
      }
    });

    core.registerService(HOST, "");

    expect(timer.armedDeadline).toBe(1100);
    expect(scheduler.live().map((entry) => entry.delayMilliseconds)).toEqual([100]);
  });

  it("waits again when its longest wait ends before the deadline, never advancing the core early", () => {
    const { core, dispatched } = createRecordedCore();
    const clock = new FakeClock();
    const scheduler = new FakeScheduler();
    const timer = new CoreTimer(core, { clock, scheduler });
    const farAway = 3_000_000_000;
    timedWant(core, waitingConsumer(core), clock, farAway);

    clock.current = 1000 + 2_147_483_647;
    scheduler.fireNext();

    expect(timer.armedDeadline).toBe(1000 + farAway);
    expect(scheduler.live().map((entry) => entry.delayMilliseconds)).toEqual([farAway - 2_147_483_647]);
    expect(dispatched.some((event) => event.kind === "want-settled")).toBe(false);
  });

  it("tells its move listener of every arm and disarm, in the order the core announced them", () => {
    const { core } = createRecordedCore();
    const clock = new FakeClock();
    const scheduler = new FakeScheduler();
    const moves: (number | undefined)[] = [];
    new CoreTimer(core, { clock, scheduler, onMove: (deadline) => moves.push(deadline) });
    const beta = waitingConsumer(core);
    timedWant(core, beta, clock, 500);
    timedWant(core, beta, clock, 250);

    clock.current = 1250;
    scheduler.fireNext();
    clock.current = 1500;
    scheduler.fireNext();

    expect(moves).toEqual([1500, 1250, 1500, undefined]);
  });

  const endingCalls: Record<string, (core: Core, plugins: { readonly alpha: bigint; readonly beta: bigint; readonly want: bigint }) => void> = {
    "registering the service it waits for": (core, { alpha }) => void core.registerService(alpha, "alpha:greeting"),
    "unregistering the want": (core, { want }) => void core.unregister(want),
    "releasing the plugin that wants": (core, { beta }) => void core.releasePlugin(beta),
    "quarantining the plugin that wants": (core, { beta }) => void core.quarantinePlugin(beta),
  };

  it("re-arms for the next deadline after advancing past the first", () => {
    const { core } = createRecordedCore();
    const clock = new FakeClock();
    const scheduler = new FakeScheduler();
    const timer = new CoreTimer(core, { clock, scheduler });
    const beta = waitingConsumer(core);
    timedWant(core, beta, clock, 250);
    timedWant(core, beta, clock, 500);

    clock.current = 1250;
    scheduler.fireNext();

    expect(timer.armedDeadline).toBe(1500);
    expect(scheduler.live().map((entry) => entry.delayMilliseconds)).toEqual([250]);
  });

  it("cancels its timer after a capacity answer settles a constrained want", () => {
    const storeId = "alpha:store";
    const { core, dispatched } = createRecordedCore({
      options: { constraintVocabulary: [{ constraintName: "minimumReplicas", attributeName: "replicas", bound: Bound.Lower }] },
    });
    const clock = new FakeClock();
    const timer = new CoreTimer(core, { clock, scheduler: new FakeScheduler() });
    const alpha = openPlugin(core, { importName: "alpha", services: { provides: [{ id: storeId, attributes: [{ name: "replicas", value: 1 }] }] } });
    const beta = openPlugin(core, {
      importName: "beta",
      services: { consumes: [{ id: storeId, constraints: [{ name: "minimumReplicas", value: 3 }] }] },
    });
    const registration = core.registerService(alpha, storeId).value!;
    const want = core.wantService(beta, storeId, { now: clock.now(), pollMillis: 100 }).value!;
    const armedWhileAsking = timer.armedDeadline;

    const isQuestion = (event: CoreEvent) => event.kind === "capacity-wanted" && event.want === want;
    for (let question = [...dispatched].reverse().find(isQuestion); question?.kind === "capacity-wanted"; ) {
      const answered = core.reportCapacity(
        want,
        registration,
        { request: question.request, attributes: [{ name: "replicas", value: 3 }], serves: Choice.Yes },
        clock.now(),
      );
      question = answered.events.find(isQuestion);
    }

    expect(armedWhileAsking).toBe(1100);
    expect(dispatched.filter((event) => event.kind === "want-settled").at(-1)).toMatchObject({ kind: "want-settled", want, implementation: registration });
    expect(timer.armedDeadline).toBeUndefined();
  });

  for (const [name, end] of Object.entries(endingCalls)) {
    it(`cancels its timer after ${name}`, () => {
      const { core } = createRecordedCore();
      const clock = new FakeClock();
      const scheduler = new FakeScheduler();
      const timer = new CoreTimer(core, { clock, scheduler });
      const alpha = provider(core);
      const beta = waitingConsumer(core);
      const want = timedWant(core, beta, clock, 250);

      end(core, { alpha, beta, want });

      expect(timer.armedDeadline).toBeUndefined();
      expect(scheduler.live()).toEqual([]);
    });
  }
});

describe("the system clock", () => {
  it("answers performance.now() floored to whole milliseconds", () => {
    const before = Math.floor(performance.now());
    const now = systemClock.now();
    expect(Number.isInteger(now)).toBe(true);
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(performance.now());
  });
});
