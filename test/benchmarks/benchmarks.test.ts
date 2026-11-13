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
import { echoLibraryPath } from "../host/world.ts";
import { coreLibraryPath } from "../real-core.ts";
import { standardLibraryPath } from "../real-standard.ts";

const libraries = { coreLibraryPath, standardLibraryPath };
const timeout = 120_000;
/** Enough batches to show a path slowed far past its budget, at a fraction of the gate's run time. */
const briefSampling = { warmupCalls: 1_000, batches: 21 };

function report(name: string, summary: Summary): void {
  console.log(
    `weivel-benchmark ${name} runner=${process.platform}-${process.arch} node=${process.version}` +
      ` median_ns=${summary.median.toFixed(2)} lower_quartile_ns=${summary.lowerQuartile.toFixed(2)}` +
      ` upper_quartile_ns=${summary.upperQuartile.toFixed(2)} p99_ns=${summary.percentile99.toFixed(2)}`,
  );
}

describe("a same-language service call through weivel", () => {
  it("costs what the same call made directly costs, within the measured noise, and stays within its budget", { timeout }, () => {
    const pair = benchmarkSameLanguageCall(libraries);
    report("same-language-direct", pair.direct);
    report("same-language-direct-again", pair.directAgain);
    report("same-language-through-weivel", pair.throughWeivel);
    const ratio = pairRatio(pair.throughWeivel, pair.direct);
    console.log(`weivel-benchmark same-language-ratios noise=${pairRatio(pair.directAgain, pair.direct).toFixed(4)} weivel=${ratio.toFixed(4)}`);

    expect(withinRatio(ratio, benchmarkBudgets.sameLanguageRatioBound)).toBe(true);
    expect(judge(pair.throughWeivel, benchmarkBudgets.sameLanguageCall).within).toBe(true);
  });

  it("is told apart from the direct call once it is slowed", { timeout }, () => {
    const pair = benchmarkSameLanguageCall({ ...libraries, sampling: { ...briefSampling, callsPerBatch: 1_000 }, addedNanoseconds: 200 });

    expect(withinRatio(pairRatio(pair.throughWeivel, pair.direct), benchmarkBudgets.sameLanguageRatioBound)).toBe(false);
    expect(judge(pair.throughWeivel, benchmarkBudgets.sameLanguageCall).within).toBe(false);
  });
});

describe("a core control call through koffi", () => {
  it("stays within its budget", { timeout }, () => {
    const summary = benchmarkControlCall(libraries);
    report("control-call", summary);

    expect(judge(summary, benchmarkBudgets.controlCall).within).toBe(true);
  });

  it("is over its budget once it is slowed past it", { timeout }, () => {
    const added = benchmarkBudgets.controlCall.medianNanoseconds * 2;
    const summary = benchmarkControlCall({ ...libraries, sampling: { ...briefSampling, callsPerBatch: 20 }, addedNanoseconds: added });

    expect(judge(summary, benchmarkBudgets.controlCall).within).toBe(false);
  });
});

describe("a C library call through the host's bytes binding", () => {
  it("stays within its budget", { timeout }, () => {
    const summary = benchmarkLibraryCall({ ...libraries, echoLibraryPath });
    report("library-call", summary);

    expect(judge(summary, benchmarkBudgets.libraryCall).within).toBe(true);
  });

  it("is over its budget once it is slowed past it", { timeout }, () => {
    const added = benchmarkBudgets.libraryCall.medianNanoseconds * 2;
    const summary = benchmarkLibraryCall({ ...libraries, echoLibraryPath, sampling: { ...briefSampling, callsPerBatch: 20 }, addedNanoseconds: added });

    expect(judge(summary, benchmarkBudgets.libraryCall).within).toBe(false);
  });
});
