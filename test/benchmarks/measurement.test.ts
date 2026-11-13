import { describe, it } from "vitest";
import { benchmarkControlCall } from "../../src/benchmarks/index.ts";
import { coreLibraryPath } from "../real-core.ts";
import { standardLibraryPath } from "../real-standard.ts";

const libraries = { coreLibraryPath, standardLibraryPath };
const runner = `runner=${process.platform}-${process.arch}`;

describe("measurement", () => {
  it("prints the control gate's round-median ratio five times", { timeout: 600_000 }, () => {
    for (let repeat = 0; repeat < 5; repeat++) {
      const control = benchmarkControlCall(libraries);
      console.log(`weivel-measure ${runner} repeat=${repeat} control_round_median=${control.roundRatio.median.toFixed(4)}`);
    }
  });
});
