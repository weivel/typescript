import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Summary } from "./measure.js";

export type RatioGate = "controlCall" | "libraryCall";

/**
 * The bounds the kit sets for this language, read from its `benchmarks/typescript.txt`: each ratio gate's highest
 * measured ratio per kit platform, the margin over it, and the noise a same-language pair is judged against.
 */
export interface LanguageBudget {
  readonly highestMeasuredRatio: Readonly<Record<RatioGate, Readonly<Record<string, number>>>>;
  readonly ratioMargin: number;
  readonly quietNoise: number;
  readonly worstNoise: number;
  readonly noiseMargin: number;
}

const gatesByKitName: Readonly<Record<string, RatioGate>> = { "control-call": "controlCall", "library-call": "libraryCall" };
const scalarsByKitName = {
  "ratio-margin": "ratioMargin",
  "quiet-noise": "quietNoise",
  "worst-noise": "worstNoise",
  "noise-margin": "noiseMargin",
} as const;
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
  readonly scalars: Partial<Record<ScalarName, number>>;
}

function readLine(line: string, read: BudgetLines): void {
  const fields = line.split(" ");
  const gate = gatesByKitName[fields[0]!];
  const scalar = scalarsByKitName[fields[0] as keyof typeof scalarsByKitName];
  if (gate !== undefined && fields.length === 3 && kitPlatforms.includes(fields[1]!)) {
    read.highest[gate][fields[1]!] = positiveNumber(fields[2]!, line);
  } else if (scalar !== undefined && fields.length === 2) {
    read.scalars[scalar] = positiveNumber(fields[1]!, line);
  } else {
    throw new Error(`The budget line "${line}" is neither a gate on a kit platform nor one of the kit's scalars.`);
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
 * @throws Error for a line the format does not define, a number that is not positive, or a missing scalar.
 */
export function readLanguageBudget(text: string): LanguageBudget {
  const read: BudgetLines = { highest: { controlCall: {}, libraryCall: {} }, scalars: {} };
  for (const line of text.split(/\r?\n/).map((candidate) => candidate.trim()).filter((candidate) => candidate.length > 0)) {
    readLine(line, read);
  }
  return {
    highestMeasuredRatio: read.highest,
    ratioMargin: scalarOf(read, "ratioMargin"),
    quietNoise: scalarOf(read, "quietNoise"),
    worstNoise: scalarOf(read, "worstNoise"),
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

/** Whether a run whose two identical direct paths differed by `noiseRatio` was noisier than any the kit measured. */
export function tooNoisyToJudge(budget: LanguageBudget, noiseRatio: number): boolean {
  return deviation(noiseRatio) > budget.worstNoise;
}

/**
 * How far from 1 the ratio of a same-language pair may be in a run whose two identical direct paths differed by
 * `noiseRatio`: the margin times that run's own noise, or times the quiet noise when the run was quieter.
 */
export function sameLanguageBound(budget: LanguageBudget, noiseRatio: number): number {
  return 1 + budget.noiseMargin * Math.max(budget.quietNoise, deviation(noiseRatio));
}

/** Whether `ratio` lies within `bound` of 1 either way: two paths equal within the noise the bound allows. */
export function withinRatio(ratio: number, bound: number): boolean {
  return ratio <= bound && ratio >= 1 / bound;
}
