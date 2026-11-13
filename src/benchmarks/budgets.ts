import type { Summary } from "./measure.js";

/**
 * The noise a same-language pair shows on a quiet run: the largest deviation from 1 of the ratio of two paths of
 * identical cost (two direct paths, or the direct path and the one through weivel) measured on the three CI runners
 * on 2026-11-13, in Test runs 43438389364 and 43441441323, two attempts each, outside the one run whose own two direct
 * paths differed by more than half.
 */
const QUIET_NOISE = 0.0772;

/** The noisiest same-language run measured on CI (macos, Test run 43441441323): beyond it a run is not judged. */
const WORST_MEASURED_NOISE = 0.5678;

/** How many times the noise a same-language pair may differ by and still count as equal. */
const NOISE_MARGIN = 2.5;

export type RatioGate = "controlCall" | "libraryCall";

/**
 * The highest per-round median ratio of weivel's call over a bare call through the same binding that each platform
 * showed under the default sampling, two attempts of five repeats each. The control call was measured with the core's
 * timer armed in Test run 43451359295, its gate's own run included (macos in attempts 2 and 3, its first never
 * started); the lowest were linux 6.68, win32 7.28, darwin 5.53. The library call was measured in Test run
 * 43444931168; the lowest were linux 30.68, win32 29.35, darwin 22.79.
 */
const highestMeasuredRatio: Readonly<Record<RatioGate, Readonly<Record<string, number>>>> = {
  controlCall: { linux: 8.0425, win32: 8.2643, darwin: 6.5947 },
  libraryCall: { linux: 35.3079, win32: 33.6923, darwin: 27.8254 },
};

/**
 * How far over its platform's highest measured ratio a run may go. It keeps every bound below twice its platform's
 * lowest measured ratio, so a call twice as slow as the fastest run measured fails on every platform; the tightest
 * case, darwin's library call, allows at most 1.63.
 */
const RATIO_MARGIN = 1.4;

/** The bound of `gate` on `platform`, or undefined for a platform no CI run has measured, which the gate fails. */
export function ratioBound(gate: RatioGate, platform: string = process.platform): number | undefined {
  const highest = highestMeasuredRatio[gate][platform];
  return highest === undefined ? undefined : highest * RATIO_MARGIN;
}

/** How many times slower `measured` ran than `reference`, by their medians. */
export function pairRatio(measured: Summary, reference: Summary): number {
  return measured.median / reference.median;
}

/** How far `ratio` is from 1, the same either way: 1.1 and 1/1.1 are both 0.1 away. */
export function deviation(ratio: number): number {
  return Math.max(ratio, 1 / ratio) - 1;
}

/** Whether a run whose two identical direct paths differed by `noiseRatio` was noisier than any measured on CI. */
export function tooNoisyToJudge(noiseRatio: number): boolean {
  return deviation(noiseRatio) > WORST_MEASURED_NOISE;
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
