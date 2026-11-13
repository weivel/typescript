import { describe, it } from "vitest";
import { benchmarkControlCall, benchmarkLibraryCall, benchmarkSameLanguageCall, pairRatio, type FfiCallSummaries, type Sampling } from "../../src/benchmarks/index.ts";
import { echoLibraryPath } from "../host/world.ts";
import { coreLibraryPath } from "../real-core.ts";
import { standardLibraryPath } from "../real-standard.ts";

const libraries = { coreLibraryPath, standardLibraryPath };
const runner = `runner=${process.platform}-${process.arch}`;
const samplings: Record<string, Sampling> = {
  small: { warmupCalls: 100_000, callsPerBatch: 200, batches: 201 },
  large: { warmupCalls: 100_000, callsPerBatch: 1_000, batches: 401 },
};

function line(name: string, pair: FfiCallSummaries): string {
  return `${name}_of_medians=${pair.weivelCall.median / pair.bareCall.median} ${name}_round_median=${pair.roundRatio.median.toFixed(4)} ${name}_round_iqr=${pair.roundRatio.lowerQuartile.toFixed(2)}-${pair.roundRatio.upperQuartile.toFixed(2)}`;
}

describe("measurement", () => {
  it("prints every gate's ratios under two samplings", { timeout: 600_000 }, () => {
    for (let repeat = 0; repeat < 5; repeat++) {
      const pair = benchmarkSameLanguageCall(libraries);
      console.log(`weivel-measure ${runner} repeat=${repeat} noise=${pairRatio(pair.directAgain, pair.direct).toFixed(4)} pair=${pairRatio(pair.throughWeivel, pair.direct).toFixed(4)}`);
      for (const [samplingName, sampling] of Object.entries(samplings)) {
        const control = benchmarkControlCall({ ...libraries, sampling });
        const library = benchmarkLibraryCall({ ...libraries, echoLibraryPath, sampling });
        console.log(`weivel-measure ${runner} repeat=${repeat} sampling=${samplingName} ${line("control", control)} ${line("library", library)}`);
      }
    }
  });
});
