import type { Summary } from "./measure.js";

export interface Budget {
  readonly medianNanoseconds: number;
}

export interface Verdict {
  readonly median: number;
  readonly budget: number;
  readonly within: boolean;
}

/** The margin over the slowest median measured, the kit's own for its C benchmark. */
const MARGIN = 2.5;

/**
 * The slowest median each path showed on the three CI runners (ubuntu, windows and macos), over two attempts of
 * five repeats each, measured on 2026-11-13 in Test run 43438389364.
 */
const slowestMeasuredMedianNanoseconds = {
  sameLanguageCall: 9.34,
  controlCall: 3439,
  libraryCall: 3516.81,
} as const;

/**
 * How far from 1 the ratio of two identical direct paths, sampled side by side, strayed at most in the same runs: the
 * measured noise of a same-language pair.
 */
const largestMeasuredNoise = 0.0611;

/**
 * Each budget is the slowest median measured times the margin; the same-language pair counts as equal while the
 * ratio of its medians stays within the measured noise times the margin of 1, either way.
 */
export const benchmarkBudgets = {
  sameLanguageCall: { medianNanoseconds: slowestMeasuredMedianNanoseconds.sameLanguageCall * MARGIN },
  controlCall: { medianNanoseconds: slowestMeasuredMedianNanoseconds.controlCall * MARGIN },
  libraryCall: { medianNanoseconds: slowestMeasuredMedianNanoseconds.libraryCall * MARGIN },
  sameLanguageRatioBound: 1 + largestMeasuredNoise * MARGIN,
} as const;

export function judge(summary: Summary, budget: Budget): Verdict {
  return { median: summary.median, budget: budget.medianNanoseconds, within: summary.median <= budget.medianNanoseconds };
}

/** How many times slower `measured` ran than `reference`, by their medians. */
export function pairRatio(measured: Summary, reference: Summary): number {
  return measured.median / reference.median;
}

/** Whether `ratio` lies within `bound` of 1 either way: two paths equal within the noise the bound allows. */
export function withinRatio(ratio: number, bound: number): boolean {
  return ratio <= bound && ratio >= 1 / bound;
}
