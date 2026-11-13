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

/** Wraps the path called `name` before it is measured; the identity when nothing needs to see or change it. */
export type PathDecorator = (name: string, path: MeasuredPath) => MeasuredPath;

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

/** The names in the order round `round` samples them: each round starts one name later than the round before. */
export function roundOrder<Name>(names: readonly Name[], round: number): Name[] {
  const start = round % names.length;
  return [...names.slice(start), ...names.slice(0, start)];
}

/** How many calls `measureInterleaved` makes of each path under `sampling`, warm-up included. */
export function callsPerPath(sampling: Sampling): number {
  return sampling.warmupCalls + sampling.batches * sampling.callsPerBatch;
}

/**
 * Samples every path in turn, one batch of each per round, so a change in the machine's speed during the run falls on
 * every path alike, and rotates which path goes first each round, so no path always follows the same one.
 */
export function measureInterleaved<Name extends string>(
  paths: Readonly<Record<Name, MeasuredPath>>,
  sampling: Sampling,
  decorate: PathDecorator = (_name, path) => path,
): Record<Name, Summary> {
  const names = Object.keys(paths) as Name[];
  const decorated = new Map<Name, MeasuredPath>(names.map((name) => [name, decorate(name, paths[name])]));
  for (const name of names) {
    timeBatch(decorated.get(name)!, sampling.warmupCalls);
  }
  const samples = new Map<Name, number[]>(names.map((name) => [name, []]));
  for (let round = 0; round < sampling.batches; round++) {
    for (const name of roundOrder(names, round)) {
      samples.get(name)!.push(timeBatch(decorated.get(name)!, sampling.callsPerBatch));
    }
  }
  return Object.fromEntries(names.map((name) => [name, summarise(samples.get(name)!)])) as Record<Name, Summary>;
}
