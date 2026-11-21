import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "../context/index.js";
import { runHost } from "../program/index.js";
import { hostVectorEntrySource, hostVectorManifest, type HostVectorPlugin } from "./host-plugins.js";
import type { LayerVector } from "./vectors.js";

/** The one bound LAYER.md sets on every wait of a `host` vector. */
export const hostVectorBoundMillis = 30_000;

const recordFileName = "record.txt";
/** The file the suite writes in the run directory once it has sent its stop request. */
const stopSentFileName = "stop-sent";
const entryFileName = "entry.js";
const pollMillis = 5;

/**
 * Runs the host program once over `directory`, handing it `programArguments`, and answers its exit code; aborting
 * `signal` is the run's stop request.
 */
export type HostProgramRun = (programArguments: readonly string[], signal: AbortSignal) => Promise<number>;

export interface HostVectorOptions {
  /** A build of the kit's `stub-host`, its `library.json` beside it. */
  readonly stubHostLibraryPath: string;
  readonly coreLibraryPath?: string;
  readonly standardLibraryPath?: string;
  /** How the program is run; in process through `runHost` by default. */
  readonly run?: HostProgramRun;
}

/** What a `host` vector's suite witnesses: the lines of `record.txt` and the program's exit code. */
export interface HostWitness {
  readonly id: string;
  readonly record: readonly string[];
  readonly exit: number;
}

interface StubPlugin {
  readonly name: string;
  readonly directory: string;
  readonly manifest: string;
}

interface HostGiven {
  readonly stubHost: Readonly<Record<string, unknown>> & { readonly plugins: readonly StubPlugin[] };
  readonly plugins: readonly HostVectorPlugin[];
  readonly arguments?: readonly string[];
  readonly stopAfter?: string;
}

/** A null logger: a vector judges the record, and what the program logs on the way is not part of it. */
const quietLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function inProcessRun(options: HostVectorOptions): HostProgramRun {
  return (programArguments, signal) =>
    runHost({
      hostLibraryPath: options.stubHostLibraryPath,
      arguments: programArguments,
      signal,
      log: quietLog,
      ...(options.coreLibraryPath === undefined ? {} : { coreLibraryPath: options.coreLibraryPath }),
      ...(options.standardLibraryPath === undefined ? {} : { standardLibraryPath: options.standardLibraryPath }),
    });
}

function writeFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/**
 * Lays the vector's run out in `directory`: each plugin's manifest and entry at the paths its stub-host entry names,
 * the manifest left out for a plugin whose `unreadableManifest` is true, and `stub-host.json` naming each entry it
 * wrote.
 *
 * @throws Error for a plugin the stub-host file names and the vector gives no steps for, or a step this driver does
 * not realise.
 */
function layOut(given: HostGiven, directory: string): void {
  const plugins = given.stubHost.plugins.map((stub) => {
    const realised = given.plugins.find((plugin) => plugin.name === stub.name);
    if (realised === undefined) {
      throw new Error(`The vector gives no steps for the plugin ${stub.name}.`);
    }
    const entry = `${stub.directory}/${entryFileName}`;
    if (realised.unreadableManifest !== true) {
      writeFile(join(directory, stub.manifest), JSON.stringify(hostVectorManifest(stub.name, entryFileName)));
    }
    writeFile(join(directory, entry), hostVectorEntrySource(realised, directory, hostVectorBoundMillis));
    return { ...stub, entry };
  });
  writeFile(join(directory, "stub-host.json"), JSON.stringify({ ...given.stubHost, plugins }));
}

/** The complete lines of the record: a line counts once the newline after it is written. */
function recordLines(directory: string): string[] {
  const path = join(directory, recordFileName);
  if (!existsSync(path)) {
    return [];
  }
  const lines = readFileSync(path, "utf8").split("\n");
  return lines.slice(0, -1).map((line) => line.replace(/\r$/, ""));
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Waits until the record holds `line` or the run ends, within the bound measured from `startedAt`. */
async function awaitLine(directory: string, line: string, run: { ended: boolean }, startedAt: number): Promise<void> {
  while (!recordLines(directory).includes(line)) {
    if (run.ended) {
      throw new Error(`The run ended before the record held ${JSON.stringify(line)}.`);
    }
    if (Date.now() - startedAt > hostVectorBoundMillis) {
      throw new Error(`The record did not hold ${JSON.stringify(line)} within ${hostVectorBoundMillis} ms of the run starting.`);
    }
    await sleep(pollMillis);
  }
}

async function withinTheBound(running: Promise<number>, what: string): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`The run did not end within ${hostVectorBoundMillis} ms of ${what}.`)), hostVectorBoundMillis);
  });
  try {
    return await Promise.race([running, bound]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends the run its stop request and then writes `stop-sent`, as LAYER.md says.
 *
 * @implNote An AbortSignal runs its listeners within `abort()`, so a run that takes the request in process has taken
 * it, and one that forwards it to a child has sent it, before the file is written.
 */
function sendStop(stopRequest: AbortController, directory: string): void {
  stopRequest.abort();
  writeFileSync(join(directory, stopSentFileName), "");
}

async function drive(given: HostGiven, directory: string, run: HostProgramRun): Promise<number> {
  const stopRequest = new AbortController();
  const startedAt = Date.now();
  const state = { ended: false };
  const running = run([directory, ...(given.arguments ?? [])], stopRequest.signal).finally(() => {
    state.ended = true;
  });
  if (given.stopAfter === undefined) {
    return withinTheBound(running, "starting");
  }
  try {
    await awaitLine(directory, given.stopAfter, state, startedAt);
  } catch (error) {
    stopRequest.abort();
    await running.catch(() => undefined);
    throw error;
  }
  if (state.ended) {
    return running;
  }
  sendStop(stopRequest, directory);
  return withinTheBound(running, "its stop request");
}

/**
 * Runs a `host` vector as LAYER.md says: lays its plugins and `stub-host.json` out in a fresh directory, runs the
 * program over it, sends the stop request once the record holds `stopAfter`, and answers the record and the exit code.
 *
 * @throws Error for a vector of another op, a plugin or step this driver does not realise, or a wait past the bound.
 */
export async function witnessHostVector(vector: LayerVector, options: HostVectorOptions): Promise<HostWitness> {
  if (vector.op !== "host") {
    throw new Error(`The vector ${vector.id} has the op ${vector.op}, not host.`);
  }
  const given = vector.given as unknown as HostGiven;
  const directory = mkdtempSync(join(tmpdir(), "weivel-host-vector-"));
  try {
    layOut(given, directory);
    const exit = await drive(given, directory, options.run ?? inProcessRun(options));
    return { id: vector.id, record: recordLines(directory), exit };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
