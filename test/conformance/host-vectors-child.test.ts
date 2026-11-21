import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readLayerVectors, type HostProgramRun } from "../../src/conformance/index.ts";
import { failedRunExit } from "../../src/program/index.ts";
import { bundleRelocatedProgram, childProgramRun, killEveryChild, runningChildPids, type RelocatedProgram } from "../program/child.ts";
import { isAlive, processTreeOf } from "../program/process-tree.ts";
import { hostTestTimeout, hostVector, judgeHostVector, witness } from "../program/world.ts";
import { layerVectorDirectory } from "./kit.ts";

const hostVectors = readLayerVectors(layerVectorDirectory).filter((vector) => vector.op === "host");
const treeBoundMillis = 10_000;
let relocated: RelocatedProgram;
let run: HostProgramRun;

beforeAll(async () => {
  relocated = await bundleRelocatedProgram();
  run = childProgramRun(relocated.program);
});

afterEach(killEveryChild);

afterAll(() => relocated.remove());

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Polls `condition` until it holds, failing past the bound. */
async function eventually(condition: () => boolean, what: string): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > treeBoundMillis) {
      throw new Error(`${what} did not happen within ${treeBoundMillis} ms`);
    }
    await sleep(50);
  }
}

/**
 * Waits, within the bound, for the run of a killed child to end, which it does once Node has seen the child exit.
 *
 * @implNote On POSIX a signalled child stays a zombie that `kill(pid, 0)` still finds until libuv reaps it on a later
 * turn, so the tree is judged only after the exit; Windows's taskkill leaves nothing to reap, so there the check runs
 * at once, which is what tells a tree kill from a relay-only one.
 */
async function reaped(run: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`The killed child did not exit within ${treeBoundMillis} ms`)), treeBoundMillis);
  });
  try {
    await Promise.race([run, bound]);
  } finally {
    clearTimeout(timer);
  }
}

/** A serve run with nothing to tick, so the program waits for a stop request that never comes. */
const servingUntilStopped = hostVector("serving-until-stopped", {
  stubHost: { mode: "serve", plugins: [{ name: "alpha", directory: "alpha", manifest: "alpha/manifest.json", scope: true }] },
  plugins: [{ name: "alpha", activate: [{ log: "up" }] }],
  stopAfter: "a line no run writes",
});

describe("the bundled program as a child process", () => {
  it("has host vectors to run", () => {
    expect(hostVectors.length).toBeGreaterThan(0);
  });

  for (const vector of hostVectors) {
    it(`runs ${vector.id} as the vector states, relocated beside its libraries and koffi`, () => judgeHostVector(vector, run), hostTestTimeout);
  }

  it(
    "loads the native libraries from beside the bundle, not from this package",
    async () => {
      const bare = await bundleRelocatedProgram(false);
      try {
        const endsWithoutAStop = hostVectors.find((vector) => vector.id === "host/a-malformed-next-ends-the-run")!;
        const seen = await witness(endsWithoutAStop, childProgramRun(bare.program));

        expect(seen.exit).toBe(failedRunExit);
        expect(seen.record).toEqual([]);
      } finally {
        bare.remove();
      }
    },
    hostTestTimeout,
  );

  it(
    "leaves no process of a child's tree behind once it is killed mid-serve",
    async () => {
      const witnessed = witness(servingUntilStopped, run).catch((error: unknown) => error);
      const relayConsoleAndProgram = 3;
      const minimumTree = process.platform === "win32" ? relayConsoleAndProgram : 1;
      let tree: number[] = [];
      await eventually(() => {
        const [root] = runningChildPids();
        tree = root === undefined ? [] : processTreeOf(root);
        return tree.length >= minimumTree;
      }, "the child's tree starting");

      killEveryChild();
      if (process.platform !== "win32") {
        await reaped(witnessed);
      }

      expect(tree.filter(isAlive)).toEqual([]);
      expect(await witnessed).toBeInstanceOf(Error);
    },
    hostTestTimeout,
  );
});
