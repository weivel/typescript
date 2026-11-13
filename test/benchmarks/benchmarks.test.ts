import koffi from "koffi";
import { describe, expect, it } from "vitest";
import {
  benchmarkControlCall,
  benchmarkLibraryCall,
  benchmarkSameLanguageCall,
  callsPerPath,
  pairRatio,
  ratioBound,
  roundOrder,
  sameLanguageBound,
  tooNoisyToJudge,
  withinRatio,
  type FfiCallSummaries,
  type MeasuredPath,
  type PathDecorator,
  type RatioGate,
  type Sampling,
  type Summary,
} from "../../src/benchmarks/index.ts";
import { loadCoreLibrary, type CoreLibrary } from "../../src/core/index.ts";
import { echoLibraryPath } from "../host/world.ts";
import { coreLibraryPath } from "../real-core.ts";

const libraries = { coreLibraryPath };
const timeout = 120_000;
/** Enough batches to tell a slowed path apart, or to count crossings, at a fraction of the gate's run time. */
const briefSampling: Sampling = { warmupCalls: 1_000, callsPerBatch: 20, batches: 21 };

function report(name: string, summary: Summary): void {
  console.log(
    `weivel-benchmark ${name} runner=${process.platform}-${process.arch} node=${process.version}` +
      ` median_ns=${summary.median.toFixed(2)} lower_quartile_ns=${summary.lowerQuartile.toFixed(2)}` +
      ` upper_quartile_ns=${summary.upperQuartile.toFixed(2)} p99_ns=${summary.percentile99.toFixed(2)}`,
  );
}

function reportRatio(name: string, ratio: number): void {
  console.log(`weivel-benchmark ${name} runner=${process.platform}-${process.arch} ratio=${ratio.toFixed(4)}`);
}

function busyWait(nanoseconds: number): void {
  const end = process.hrtime.bigint() + BigInt(Math.round(nanoseconds));
  while (process.hrtime.bigint() < end) {
    continue;
  }
}

/** Spins `nanoseconds` before every call of the path named `slowedName`: the slowed path a red proof needs. */
function slowing(slowedName: string, nanoseconds: number): PathDecorator {
  return (name, path) => (name === slowedName ? (call) => (busyWait(nanoseconds), path(call)) : path);
}

/** Counts every call of each measured path, by its name. */
function countingPaths(): { decorate: PathDecorator; calls: Map<string, number> } {
  const calls = new Map<string, number>();
  const decorate: PathDecorator = (name, path): MeasuredPath => (call) => {
    calls.set(name, (calls.get(name) ?? 0) + 1);
    return path(call);
  };
  return { decorate, calls };
}

type NativeFunction = (...parameters: unknown[]) => unknown;

function countedFunction(symbol: string, native: NativeFunction, crossings: Map<string, number>): NativeFunction {
  return (...parameters) => {
    crossings.set(symbol, (crossings.get(symbol) ?? 0) + 1);
    return native(...parameters);
  };
}

/** The core library bound as the layer binds it, with `symbols` counted on every call into C. */
function countingCoreLibrary(symbols: readonly string[], crossings: Map<string, number>): CoreLibrary {
  const library = loadCoreLibrary(coreLibraryPath);
  const functions = { ...library.functions } as Record<string, NativeFunction>;
  for (const symbol of symbols) {
    functions[symbol] = countedFunction(symbol, functions[symbol]!, crossings);
  }
  return { path: library.path, functions: functions as unknown as CoreLibrary["functions"] };
}

/** Runs `run` while every function koffi binds from a newly loaded library is counted on every call into C. */
async function withCountedKoffi<Answer>(crossings: Map<string, number>, run: () => Promise<Answer>): Promise<Answer> {
  const load = koffi.load;
  koffi.load = ((path: string, ...rest: unknown[]) => {
    const library = (load as (...parameters: unknown[]) => koffi.IKoffiLib)(path, ...rest);
    const bind = library.func.bind(library) as (...parameters: unknown[]) => NativeFunction;
    return Object.assign(Object.create(library) as koffi.IKoffiLib, {
      func: (symbol: string, ...signature: unknown[]) => countedFunction(symbol, bind(symbol, ...signature), crossings),
      unload: () => library.unload(),
    });
  }) as typeof koffi.load;
  try {
    return await run();
  } finally {
    koffi.load = load;
  }
}

function reportFfiPair(name: string, summaries: FfiCallSummaries): number {
  report(`${name}-bare`, summaries.bareCall);
  report(name, summaries.weivelCall);
  reportRatio(`${name}-over-bare`, summaries.roundRatio.median);
  return summaries.roundRatio.median;
}

/** The gate's bound on this platform; a platform no CI run has measured fails the gate rather than passing it. */
function boundHere(gate: RatioGate): number {
  const bound = ratioBound(gate);
  if (bound === undefined) {
    throw new Error(`No CI run has measured ${gate} on ${process.platform}, so it has no bound and cannot pass.`);
  }
  return bound;
}

/** Spins long enough to push the weivel call past `bound` times the bare call `measured` saw. */
function slowdownPast(bound: number, measured: FfiCallSummaries): number {
  return measured.bareCall.median * bound * 2;
}

describe("a same-language service call through weivel", () => {
  it("costs what the same call made directly costs, within the noise measured in the same run", { timeout }, () => {
    const pair = benchmarkSameLanguageCall(libraries);
    report("same-language-direct", pair.direct);
    report("same-language-direct-again", pair.directAgain);
    report("same-language-through-weivel", pair.throughWeivel);
    const noise = pairRatio(pair.directAgain, pair.direct);
    reportRatio("same-language-noise", noise);
    const ratio = pairRatio(pair.throughWeivel, pair.direct);
    reportRatio("same-language-weivel", ratio);

    expect(tooNoisyToJudge(noise), `the run was too noisy to judge: its two identical direct paths differed by ${noise.toFixed(4)}`).toBe(false);
    expect(withinRatio(ratio, sameLanguageBound(noise))).toBe(true);
  });

  it("is told apart from the direct call once it is slowed", { timeout }, () => {
    const pair = benchmarkSameLanguageCall({
      ...libraries,
      sampling: { ...briefSampling, callsPerBatch: 1_000 },
      decorate: slowing("throughWeivel", 200),
    });

    const bound = sameLanguageBound(pairRatio(pair.directAgain, pair.direct));

    expect(withinRatio(pairRatio(pair.throughWeivel, pair.direct), bound)).toBe(false);
  });
});

describe("a core control call through koffi", () => {
  it("costs at most its budgeted multiple of a bare call into the core", { timeout }, () => {
    const ratio = reportFfiPair("control-call", benchmarkControlCall(libraries));

    expect(ratio).toBeLessThanOrEqual(boundHere("controlCall"));
  });

  it("is over its budget once it is slowed past it", { timeout }, () => {
    const options = { ...libraries, sampling: briefSampling };
    const added = slowdownPast(boundHere("controlCall"), benchmarkControlCall(options));
    const slowed = benchmarkControlCall({ ...options, decorate: slowing("weivelCall", added) });

    expect(slowed.roundRatio.median).toBeGreaterThan(boundHere("controlCall"));
  });

  it("crosses into the core once for every call of each path, with no drain or re-arm of its own", { timeout }, () => {
    const crossings = new Map<string, number>();
    const paths = countingPaths();
    const coreLibrary = countingCoreLibrary(
      ["weivel_get_service", "weivel_support_release", "weivel_next_event", "weivel_next_deadline"],
      crossings,
    );

    benchmarkControlCall({ ...libraries, coreLibrary, sampling: briefSampling, decorate: paths.decorate });

    expect(paths.calls.get("weivelCall")).toBe(callsPerPath(briefSampling));
    expect(crossings.get("weivel_get_service")).toBe(paths.calls.get("weivelCall"));
    expect(crossings.get("weivel_support_release")).toBe(paths.calls.get("bareCall"));
    expect(crossings.get("weivel_next_deadline") ?? 0).toBe(0);
    expect(crossings.get("weivel_next_event") ?? 0).toBeLessThan(callsPerPath(briefSampling));
  });
});

describe("a C library call through the host's bytes binding", () => {
  it("costs at most its budgeted multiple of a bare call into the library", { timeout }, async () => {
    const ratio = reportFfiPair("library-call", await benchmarkLibraryCall({ ...libraries, echoLibraryPath }));

    expect(ratio).toBeLessThanOrEqual(boundHere("libraryCall"));
  });

  it("is over its budget once it is slowed past it", { timeout }, async () => {
    const options = { ...libraries, echoLibraryPath, sampling: briefSampling };
    const added = slowdownPast(boundHere("libraryCall"), await benchmarkLibraryCall(options));
    const slowed = await benchmarkLibraryCall({ ...options, decorate: slowing("weivelCall", added) });

    expect(slowed.roundRatio.median).toBeGreaterThan(boundHere("libraryCall"));
  });

  it("crosses into the library once for every call of each path, releasing every answer", { timeout }, async () => {
    const crossings = new Map<string, number>();
    const paths = countingPaths();

    await withCountedKoffi(crossings, () =>
      benchmarkLibraryCall({ ...libraries, echoLibraryPath, sampling: briefSampling, decorate: paths.decorate }),
    );

    expect(paths.calls.get("weivelCall")).toBe(callsPerPath(briefSampling));
    expect(crossings.get("echo_echo")).toBe(paths.calls.get("weivelCall"));
    expect(crossings.get("echo_release")).toBe(paths.calls.get("weivelCall")! + paths.calls.get("bareCall")!);
  });
});

describe("the measuring", () => {
  it("starts each round one path later, so no path always follows the same one", () => {
    expect([0, 1, 2, 3].map((round) => roundOrder(["a", "b", "c"], round).join(""))).toEqual(["abc", "bca", "cab", "abc"]);
  });

  it("widens the same-language bound to a noisy run's own noise, and never below the quiet noise", () => {
    expect(sameLanguageBound(1)).toBeCloseTo(1.193, 3);
    expect(sameLanguageBound(1 / 1.5)).toBeCloseTo(2.25, 3);
    expect(sameLanguageBound(1.5)).toBeCloseTo(2.25, 3);
  });

  it("refuses to judge a same-language run noisier than any measured on CI", () => {
    expect(tooNoisyToJudge(1.5)).toBe(false);
    expect(tooNoisyToJudge(1.6)).toBe(true);
    expect(tooNoisyToJudge(1 / 1.6)).toBe(true);
  });

  it("has a bound for each measured platform and none for a platform no CI run measured", () => {
    for (const gate of ["controlCall", "libraryCall"] as const) {
      expect(["linux", "win32", "darwin"].map((platform) => ratioBound(gate, platform) !== undefined)).toEqual([true, true, true]);
      expect(ratioBound(gate, "freebsd")).toBeUndefined();
    }
  });
});
