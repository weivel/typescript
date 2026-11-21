import { describe, expect, it } from "vitest";
import { StopRequest } from "../../src/program/stop-request.ts";

describe("a run's wait for its next tick", () => {
  it("reads the clock again after each wait and waits again while it still reads before the time", async () => {
    const readings = [0, 4, 9, 10];
    const read: number[] = [];
    const clock = (): number => {
      const now = readings[Math.min(read.length, readings.length - 1)]!;
      read.push(now);
      return now;
    };

    await new StopRequest().until(10, clock);

    expect(read).toEqual([0, 4, 9, 10]);
  });

  it("ends at once on a stop request, however far away the time is", async () => {
    const stopRequest = new AbortController();
    const started = Date.now();
    const waiting = new StopRequest(stopRequest.signal).until(Date.now() + 600_000);

    stopRequest.abort();
    await waiting;

    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
