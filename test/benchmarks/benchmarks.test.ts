import { describe, expect, it } from "vitest";
import {
  benchmarkBudgets,
  benchmarkControlCall,
  benchmarkLibraryCall,
  benchmarkSameLanguageCall,
  judge,
  pairRatio,
  withinRatio,
  type Summary,
} from "../../src/benchmarks/index.ts";
import { coreLibraryPath } from "../real-core.ts";
import { standardLibraryPath } from "../real-standard.ts";
import { echoLibraryPath } from "../host/world.ts";

const libraries = { coreLibraryPath, standardLibraryPath };
const repeats = 5;

function line(name: string, summary: Summary): string {
  return [
    `weivel-benchmark ${name}`,
    `runner=${process.platform}-${process.arch}`,
    `node=${process.version}`,
    `median_ns=${summary.median.toFixed(2)}`,
    `lower_quartile_ns=${summary.lowerQuartile.toFixed(2)}`,
    `upper_quartile_ns=${summary.upperQuartile.toFixed(2)}`,
    `p99_ns=${summary.percentile99.toFixed(2)}`,
  ].join(" ");
}

describe("measurement", () => {
  it("prints every benchmark's medians", { timeout: 300_000 }, () => {
    for (let repeat = 0; repeat < repeats; repeat++) {
      const pair = benchmarkSameLanguageCall(libraries);
      console.log(line("same-language-direct", pair.direct));
      console.log(line("same-language-direct-again", pair.directAgain));
      console.log(line("same-language-through-weivel", pair.throughWeivel));
      console.log(`weivel-benchmark same-language-ratios runner=${process.platform}-${process.arch} noise=${pairRatio(pair.directAgain, pair.direct).toFixed(4)} weivel=${pairRatio(pair.throughWeivel, pair.direct).toFixed(4)}`);
      console.log(line("control-call", benchmarkControlCall(libraries)));
      console.log(line("library-call", benchmarkLibraryCall({ ...libraries, echoLibraryPath })));
    }
    expect(withinRatio(1, benchmarkBudgets.sameLanguageRatioBound)).toBe(true);
    expect(judge(benchmarkControlCall(libraries), benchmarkBudgets.controlCall).within).toBe(true);
  });
});
