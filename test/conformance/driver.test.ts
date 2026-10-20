import { describe, expect, it } from "vitest";
import { Readable, Writable } from "node:stream";
import { answer, serve } from "../../src/conformance/driver.js";

describe("answer", () => {
  it("leaves an op it does not know unwitnessed", async () => {
    expect((await answer({ id: "x/one", op: "nonsense" })).witnessed).toBe(false);
  });

  it("does not resolve an op through the prototype chain", async () => {
    expect((await answer({ id: "x/one", op: "toString" })).witnessed).toBe(false);
  });

  it("hands an op its given and never the vector's then", async () => {
    const seen: unknown[] = [];
    const spy = (given: Record<string, unknown>): Record<string, unknown> => {
      seen.push(given);
      return {};
    };
    const vector = { id: "x/one", op: "spy", given: { a: 1 }, then: { b: 2 } };
    await answer(vector, { spy });
    expect(seen).toEqual([{ a: 1 }]);
    expect(seen[0]).not.toHaveProperty("then");
  });

  it("keys each outcome by the id of its vector", async () => {
    const echo = (given: Record<string, unknown>): Record<string, unknown> => given;
    const first = await answer({ id: "x/first", op: "echo", given: { n: 1 } }, { echo });
    const second = await answer({ id: "x/second", op: "echo", given: { n: 2 } }, { echo });
    expect([first.id, second.id]).toEqual(["x/first", "x/second"]);
    expect([first.result, second.result]).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("writes one line per vector read from stdin, keyed by id", async () => {
    const echo = (given: Record<string, unknown>): Record<string, unknown> => given;
    const written: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, done) {
        written.push(String(chunk));
        done();
      },
    });
    const input = Readable.from([
      '{"id":"x/first","op":"echo","given":{"n":1}}\n{"id":"x/second","op":"echo","given":{"n":2}}\n',
    ]);
    await serve(input, output, { echo });
    const outcomes = written.join("").trim().split("\n").map((line) => JSON.parse(line));
    expect(outcomes.map((outcome) => outcome.id)).toEqual(["x/first", "x/second"]);
  });

  it("answers witnessed with an error when an op throws", async () => {
    const fails = (): Record<string, unknown> => {
      throw new Error("boom");
    };
    const outcome = await answer({ id: "x/one", op: "fails" }, { fails });
    expect(outcome.witnessed).toBe(true);
    expect(outcome.result).toHaveProperty("error");
  });

  it("waits for an op that settles asynchronously", async () => {
    const later = async (): Promise<Record<string, unknown>> => ({ settled: true });
    expect((await answer({ id: "x/one", op: "later" }, { later })).result).toEqual({ settled: true });
  });

  it("answers witnessed with an error when an async op rejects", async () => {
    const rejects = async (): Promise<Record<string, unknown>> => {
      throw new Error("boom");
    };
    expect((await answer({ id: "x/one", op: "rejects" }, { rejects })).result).toHaveProperty("error");
  });
});
