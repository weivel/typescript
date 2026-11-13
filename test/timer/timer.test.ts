import { describe, expect, it } from "vitest";
import { Choice, RefusalCode, type Core } from "../../src/core/index.ts";
import { CoreTimer, systemClock, type Clock, type Scheduler } from "../../src/timer/index.ts";
import { createRecordedCore, openPlugin } from "../real-core.ts";

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

    expect(dispatched.at(-1)).toMatchObject({ kind: "want-settled", want, refusal: { code: RefusalCode.TimedOut } });
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

describe("the system clock", () => {
  it("answers performance.now() floored to whole milliseconds", () => {
    const before = Math.floor(performance.now());
    const now = systemClock.now();
    expect(Number.isInteger(now)).toBe(true);
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(performance.now());
  });
});
