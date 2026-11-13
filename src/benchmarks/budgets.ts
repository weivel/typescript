import type { Summary } from "./measure.js";

export interface Budget {
  readonly medianNanoseconds: number;
}

export interface Verdict {
  readonly median: number;
  readonly budget: number;
  readonly within: boolean;
}

/** MEASUREMENT PLACEHOLDER */
export const benchmarkBudgets = {
  sameLanguageCall: { medianNanoseconds: 1e9 },
  controlCall: { medianNanoseconds: 1e9 },
  libraryCall: { medianNanoseconds: 1e9 },
  sameLanguageRatioBound: 1e9,
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
