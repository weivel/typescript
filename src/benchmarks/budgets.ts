import type { Summary } from "./measure.js";

/** MEASUREMENT PLACEHOLDER */
export const benchmarkBudgets = {
  sameLanguageRatioBound: 1e9,
  controlCallRatio: 1e9,
  libraryCallRatio: 1e9,
} as const;

/** How many times slower `measured` ran than `reference`, by their medians. */
export function pairRatio(measured: Summary, reference: Summary): number {
  return measured.median / reference.median;
}

/** Whether `ratio` lies within `bound` of 1 either way: two paths equal within the noise the bound allows. */
export function withinRatio(ratio: number, bound: number): boolean {
  return ratio <= bound && ratio >= 1 / bound;
}
