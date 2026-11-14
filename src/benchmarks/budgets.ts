import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Summary } from "./measure.js";

export type RatioGate = "controlCall" | "libraryCall";

/**
 * The bounds the kit sets for this language, read from its `benchmarks/typescript.txt`: each ratio gate's highest
 * measured ratio per kit platform, the margin over it, and per kit platform the noise a same-language pair is judged
 * against.
 */
export interface LanguageBudget {
  readonly highestMeasuredRatio: Readonly<Record<RatioGate, Readonly<Record<string, number>>>>;
  readonly ratioMargin: number;
  readonly quietNoise: Readonly<Record<string, number>>;
  readonly worstNoise: Readonly<Record<string, number>>;
  readonly noiseMargin: number;
}

/** One platform's noise bounds: how far apart two identical paths are on a quiet run, and the most a run may be. */
export interface NoiseBounds {
  readonly quiet: number;
  readonly worst: number;
}

type NoiseName = "quietNoise" | "worstNoise";

const gatesByKitName: Readonly<Record<string, RatioGate>> = { "control-call": "controlCall", "library-call": "libraryCall" };
const noiseByKitName: Readonly<Record<string, NoiseName>> = { "quiet-noise": "quietNoise", "worst-noise": "worstNoise" };
const scalarsByKitName = { "ratio-margin": "ratioMargin", "noise-margin": "noiseMargin" } as const;
type ScalarName = (typeof scalarsByKitName)[keyof typeof scalarsByKitName];
const kitPlatforms: readonly string[] = ["linux", "windows", "macos"];
const kitPlatformsByNodePlatform: Readonly<Record<string, string>> = { linux: "linux", win32: "windows", darwin: "macos" };

/** The kit's name for a Node platform, or undefined for one the kit names no bound for. */
export function kitPlatformOf(nodePlatform: string): string | undefined {
  return kitPlatformsByNodePlatform[nodePlatform];
}

/** The kit's budget file of the commit this repository pins, beside the package as CI checks it out. */
export function defaultBudgetPath(): string {
  return join(import.meta.dirname, "..", "..", "siblings", "conformance", "benchmarks", "typescript.txt");
}

function positiveNumber(text: string, line: string): number {
  const number = Number(text);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`The budget line "${line}" carries ${text}, which is not a positive number.`);
  }
  return number;
}

interface BudgetLines {
  readonly highest: Record<RatioGate, Record<string, number>>;
  readonly noise: Record<NoiseName, Record<string, number>>;
  readonly scalars: Partial<Record<ScalarName, number>>;
}

/** Where a line naming a platform keeps its number, or undefined when its first field names no gate or noise bound. */
function perPlatformRow(name: string, read: BudgetLines): Record<string, number> | undefined {
  const gate = gatesByKitName[name];
  if (gate !== undefined) {
    return read.highest[gate];
  }
  const noise = noiseByKitName[name];
  return noise === undefined ? undefined : read.noise[noise];
}

function readLine(line: string, read: BudgetLines): void {
  const fields = line.split(" ");
  const row = perPlatformRow(fields[0]!, read);
  const scalar = scalarsByKitName[fields[0] as keyof typeof scalarsByKitName];
  if (row !== undefined && fields.length === 3 && kitPlatforms.includes(fields[1]!)) {
    row[fields[1]!] = positiveNumber(fields[2]!, line);
  } else if (scalar !== undefined && fields.length === 2) {
    read.scalars[scalar] = positiveNumber(fields[1]!, line);
  } else {
    throw new Error(`The budget line "${line}" is neither a gate or noise bound on a kit platform nor one of the kit's margins.`);
  }
}

function scalarOf(read: BudgetLines, name: ScalarName): number {
  const value = read.scalars[name];
  if (value === undefined) {
    throw new Error(`The budget names no ${name}.`);
  }
  return value;
}

/**
 * Reads a budget file as the kit's RUNNER.md lays it out.
 *
 * @throws Error for a line the format does not define, a number that is not positive, or a missing margin.
 */
export function readLanguageBudget(text: string): LanguageBudget {
  const read: BudgetLines = { highest: { controlCall: {}, libraryCall: {} }, noise: { quietNoise: {}, worstNoise: {} }, scalars: {} };
  for (const line of text.split(/\r?\n/).map((candidate) => candidate.trim()).filter((candidate) => candidate.length > 0)) {
    readLine(line, read);
  }
  return {
    highestMeasuredRatio: read.highest,
    ratioMargin: scalarOf(read, "ratioMargin"),
    quietNoise: read.noise.quietNoise,
    worstNoise: read.noise.worstNoise,
    noiseMargin: scalarOf(read, "noiseMargin"),
  };
}

export function loadLanguageBudget(path: string = defaultBudgetPath()): LanguageBudget {
  return readLanguageBudget(readFileSync(path, "utf8"));
}

/** The bound of `gate` on a Node platform, or undefined for a platform the kit gives no line, which the gate fails. */
export function ratioBound(budget: LanguageBudget, gate: RatioGate, nodePlatform: string = process.platform): number | undefined {
  const kitPlatform = kitPlatformOf(nodePlatform);
  const highest = kitPlatform === undefined ? undefined : budget.highestMeasuredRatio[gate][kitPlatform];
  return highest === undefined ? undefined : highest * budget.ratioMargin;
}

/** How many times slower `measured` ran than `reference`, by their medians. */
export function pairRatio(measured: Summary, reference: Summary): number {
  return measured.median / reference.median;
}

/** How far `ratio` is from 1, the same either way: 1.1 and 1/1.1 are both 0.1 away. */
export function deviation(ratio: number): number {
  return Math.max(ratio, 1 / ratio) - 1;
}

/** The noise bounds on a Node platform, or undefined for a platform the kit gives no noise line, which the gate fails. */
export function noiseBoundsOf(budget: LanguageBudget, nodePlatform: string = process.platform): NoiseBounds | undefined {
  const kitPlatform = kitPlatformOf(nodePlatform);
  const quiet = kitPlatform === undefined ? undefined : budget.quietNoise[kitPlatform];
  const worst = kitPlatform === undefined ? undefined : budget.worstNoise[kitPlatform];
  return quiet === undefined || worst === undefined ? undefined : { quiet, worst };
}

/** Whether a run whose two identical direct paths differed by `noiseRatio` was noisier than any the kit measured. */
export function tooNoisyToJudge(bounds: NoiseBounds, noiseRatio: number): boolean {
  return deviation(noiseRatio) > bounds.worst;
}

/**
 * How far from 1 the ratio of a same-language pair may be in a run whose two identical direct paths differed by
 * `noiseRatio`: the margin times that run's own noise, or times the platform's quiet noise when the run was quieter.
 */
export function sameLanguageBound(budget: LanguageBudget, bounds: NoiseBounds, noiseRatio: number): number {
  return 1 + budget.noiseMargin * Math.max(bounds.quiet, deviation(noiseRatio));
}

/** Whether `ratio` lies within `bound` of 1 either way: two paths equal within the noise the bound allows. */
export function withinRatio(ratio: number, bound: number): boolean {
  return ratio <= bound && ratio >= 1 / bound;
}
