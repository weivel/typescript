import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bundlePlugin, bundleProgram } from "../../src/bundle/index.ts";
import type { HostProgramRun } from "../../src/conformance/index.ts";
import { defaultCoreLibraryPath, sharedLibraryFileName } from "../../src/core/index.ts";
import { defaultStandardLibraryPath } from "../../src/standard/index.ts";
import { stubHostLibraryPath } from "./world.ts";

const consoleRelayPath = join(import.meta.dirname, "console-relay.ts");
const packageKoffiDirectory = join(import.meta.dirname, "..", "..", "node_modules", "koffi");
const runningChildren = new Set<ChildProcess>();

/** The pid of every child process still running, each the root of its program's process tree. */
export function runningChildPids(): number[] {
  return [...runningChildren].flatMap((child) => (child.pid === undefined ? [] : [child.pid]));
}

/**
 * Kills every child still running together with every process under it, as one whose run outlived its bound is.
 *
 * @implNote On Windows the child is the console relay, and killing it alone would leave the program and its console
 * host running, so `taskkill /T` takes the whole tree while the relay still links it.
 */
export function killEveryChild(): void {
  for (const child of runningChildren) {
    if (process.platform === "win32" && child.pid !== undefined) {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGKILL");
    }
  }
  runningChildren.clear();
}

interface ChildProgram {
  readonly child: ChildProcess;
  /** Sends the program its stop request through its platform's terminate signals. */
  readonly requestStop: () => void;
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/** On POSIX the program is the child, and SIGTERM is its stop request. */
function spawnPosix(programArguments: readonly string[]): ChildProgram {
  const child = spawn(process.execPath, programArguments, { stdio: ["ignore", "ignore", "pipe"] });
  return { child, requestStop: () => child.kill("SIGTERM") };
}

/**
 * On Windows the program runs under `console-relay.ts`, which sends it SIGBREAK when a line reaches its stdin.
 *
 * @implNote A relay that has already exited closes its stdin, and a write to it fails with EPIPE, so the write is
 * skipped once it exited and a late failure is swallowed.
 */
function spawnWindows(programArguments: readonly string[]): ChildProgram {
  const child = spawn(process.execPath, [consoleRelayPath, process.execPath, ...programArguments], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  child.stdin?.on("error", () => {});
  const requestStop = (): void => {
    if (isRunning(child)) {
      child.stdin?.write("stop\n");
    }
  };
  return { child, requestStop };
}

/** Replaces every plugin entry `stub-host.json` in `directory` names with its bundle. */
async function bundleEveryEntry(directory: string): Promise<void> {
  const stubHost = JSON.parse(readFileSync(join(directory, "stub-host.json"), "utf8")) as { plugins: { entry: string }[] };
  const bundles = mkdtempSync(join(tmpdir(), "weivel-plugin-bundles-"));
  try {
    for (const plugin of stubHost.plugins) {
      const entry = join(directory, plugin.entry);
      const bundled = await bundlePlugin(entry, mkdtempSync(join(bundles, "plugin-")));
      renameSync(bundled, join(dirname(entry), "entry.js"));
    }
  } finally {
    rmSync(bundles, { recursive: true, force: true });
  }
}

/** A bundled program written outside this package, and how to remove it. */
export interface RelocatedProgram {
  readonly program: string;
  readonly directory: string;
  readonly remove: () => void;
}

/**
 * Bundles the program into a fresh temporary directory laid out as a deployment would be: copies of the core's and
 * the standard's shared libraries beside it, unless `withNativeLibraries` is false, and `node_modules/koffi` linked to
 * this package's koffi.
 *
 * @implNote The link is unlinked before the directory is removed, so removing it can never reach through the junction
 * into this package's koffi.
 */
export async function bundleRelocatedProgram(withNativeLibraries = true): Promise<RelocatedProgram> {
  const directory = mkdtempSync(join(tmpdir(), "weivel-relocated-program-"));
  const koffiLink = join(directory, "node_modules", "koffi");
  mkdirSync(dirname(koffiLink));
  symlinkSync(packageKoffiDirectory, koffiLink, "junction");
  if (withNativeLibraries) {
    copyFileSync(defaultCoreLibraryPath(), join(directory, sharedLibraryFileName("weivel_core")));
    copyFileSync(defaultStandardLibraryPath(), join(directory, sharedLibraryFileName("weivel_standard")));
  }
  const program = await bundleProgram(directory);
  const remove = (): void => {
    unlinkSync(koffiLink);
    rmSync(directory, { recursive: true, force: true });
  };
  return { program, directory, remove };
}

/**
 * Runs `bundledProgram` as a child process, `node <bundled program> <stub-host> <directory> ...`, every plugin entry
 * of the run bundled first, and answers its exit code; aborting the signal sends the child its stop request.
 */
export function childProgramRun(bundledProgram: string): HostProgramRun {
  return async (programArguments, signal) => {
    await bundleEveryEntry(programArguments[0]!);
    const commandLine = [bundledProgram, stubHostLibraryPath, ...programArguments];
    const { child, requestStop } = process.platform === "win32" ? spawnWindows(commandLine) : spawnPosix(commandLine);
    let standardError = "";
    child.stderr?.on("data", (chunk: Buffer) => (standardError += chunk.toString()));
    runningChildren.add(child);
    signal.addEventListener("abort", requestStop, { once: true });
    if (signal.aborted) {
      requestStop();
    }
    try {
      return await new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (code, killedBy) =>
          code === null ? reject(new Error(`The program was killed by ${killedBy}: ${standardError}`)) : resolve(code),
        );
      });
    } finally {
      runningChildren.delete(child);
      signal.removeEventListener("abort", requestStop);
    }
  };
}
