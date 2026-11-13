import type { Summary } from "./measure.js";

/**
 * The noise a same-language pair shows on a quiet run: the largest deviation from 1 of the ratio of two paths of
 * identical cost (two direct paths, or the direct path and the one through weivel) measured on the three CI runners
 * on 2026-11-13, in Test runs 43438389364 and 43441441323, two attempts each, outside the one run whose own two direct
 * paths differed by more than half.
 */
const QUIET_NOISE = 0.0772;

/** How many times the noise a same-language pair may differ by and still count as equal. */
const NOISE_MARGIN = 2.5;

/**
 * The slowest ratio of weivel's call over a bare call through the same binding measured on the three CI runners, in
 * Test run 43441441323, two attempts of five repeats each.
 */
const slowestMeasuredRatio = { controlCall: 11.41, libraryCall: 56.93 } as const;

/** How far over the slowest measured ratio a run may go; a regression of 1.5 times the slowest runner fails. */
const RATIO_MARGIN = 1.5;

export const benchmarkBudgets = {
  controlCallRatio: slowestMeasuredRatio.controlCall * RATIO_MARGIN,
  libraryCallRatio: slowestMeasuredRatio.libraryCall * RATIO_MARGIN,
} as const;

/** How many times slower `measured` ran than `reference`, by their medians. */
export function pairRatio(measured: Summary, reference: Summary): number {
  return measured.median / reference.median;
}

/** How far `ratio` is from 1, the same either way: 1.1 and 1/1.1 are both 0.1 away. */
export function deviation(ratio: number): number {
  return Math.max(ratio, 1 / ratio) - 1;
}

/**
 * How far from 1 the ratio of a same-language pair may be in a run whose two identical direct paths differed by
 * `noiseRatio`: the margin times that run's own noise, or times the quiet noise when the run was quieter.
 */
export function sameLanguageBound(noiseRatio: number): number {
  return 1 + NOISE_MARGIN * Math.max(QUIET_NOISE, deviation(noiseRatio));
}

/** Whether `ratio` lies within `bound` of 1 either way: two paths equal within the noise the bound allows. */
export function withinRatio(ratio: number, bound: number): boolean {
  return ratio <= bound && ratio >= 1 / bound;
}
