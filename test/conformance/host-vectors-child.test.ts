import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bundleProgram } from "../../src/bundle/index.ts";
import { readLayerVectors, type HostProgramRun } from "../../src/conformance/index.ts";
import { childProgramRun, killEveryChild } from "../program/child.ts";
import { hostTestTimeout, witness } from "../program/world.ts";
import { layerVectorDirectory } from "./kit.ts";

interface HostThen {
  readonly record: { readonly equals: readonly string[] };
  readonly exit?: number;
  readonly exitsNonZero?: boolean;
}

const hostVectors = readLayerVectors(layerVectorDirectory).filter((vector) => vector.op === "host");
const bundleDirectory = mkdtempSync(join(tmpdir(), "weivel-bundled-program-"));
let run: HostProgramRun;

beforeAll(async () => {
  run = childProgramRun(await bundleProgram(bundleDirectory));
});

afterEach(killEveryChild);

afterAll(() => rmSync(bundleDirectory, { recursive: true, force: true }));

describe("the bundled program as a child process", () => {
  it("has host vectors to run", () => {
    expect(hostVectors.length).toBeGreaterThan(0);
  });

  for (const vector of hostVectors) {
    it(
      `runs ${vector.id} as the vector states`,
      async () => {
        const then = vector.then as unknown as HostThen;

        const seen = await witness(vector, run);

        expect(seen.record).toEqual(then.record.equals);
        if (then.exitsNonZero === true) {
          expect(seen.exit).not.toBe(0);
        } else {
          expect(seen.exit).toBe(then.exit);
        }
      },
      hostTestTimeout,
    );
  }
});
