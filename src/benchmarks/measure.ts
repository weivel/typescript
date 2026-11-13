/** How a path is sampled: warm-up calls first, then batches of calls, each batch timed as one. */
export interface Sampling {
  readonly warmupCalls: number;
  readonly callsPerBatch: number;
  readonly batches: number;
}

/** The nanoseconds one call took, over every batch, as each batch's time divided by its calls. */
export interface Summary {
  readonly minimum: number;
  readonly lowerQuartile: number;
  readonly median: number;
  readonly upperQuartile: number;
  readonly percentile99: number;
  readonly maximum: number;
}

/** A measured path; it is handed the call's index, so no call is the same as the one before it. */
export type MeasuredPath = (call: number) => unknown;

let sink: unknown;

/** Keeps every answer reachable, so the engine cannot drop a call whose answer nobody reads. */
export function lastAnswer(): unknown {
  return sink;
}

function timeBatch(path: MeasuredPath, calls: number): number {
  const start = process.hrtime.bigint();
  for (let call = 0; call < calls; call++) {
    sink = path(call);
  }
  return Number(process.hrtime.bigint() - start) / calls;
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.max(Math.ceil(fraction * sorted.length) - 1, 0)]!;
}

export function summarise(samples: readonly number[]): Summary {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    minimum: sorted[0]!,
    lowerQuartile: percentile(sorted, 0.25),
    median: percentile(sorted, 0.5),
    upperQuartile: percentile(sorted, 0.75),
    percentile99: percentile(sorted, 0.99),
    maximum: sorted[sorted.length - 1]!,
  };
}

/**
 * Samples every path in turn, one batch of each per round, so a change in the machine's speed during the run falls on
 * every path alike.
 */
export function measureInterleaved<Name extends string>(paths: Readonly<Record<Name, MeasuredPath>>, sampling: Sampling): Record<Name, Summary> {
  const names = Object.keys(paths) as Name[];
  for (const name of names) {
    timeBatch(paths[name], sampling.warmupCalls);
  }
  const samples = new Map<Name, number[]>(names.map((name) => [name, []]));
  for (let batch = 0; batch < sampling.batches; batch++) {
    for (const name of names) {
      samples.get(name)!.push(timeBatch(paths[name], sampling.callsPerBatch));
    }
  }
  return Object.fromEntries(names.map((name) => [name, summarise(samples.get(name)!)])) as Record<Name, Summary>;
}

/** Spins until `nanoseconds` have passed: the slowed path a budget's red proof measures. */
export function busyWait(nanoseconds: number): void {
  const end = process.hrtime.bigint() + BigInt(Math.round(nanoseconds));
  while (process.hrtime.bigint() < end) {
    sink = end;
  }
}
