import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bundlePlugin } from "../../src/bundle/index.ts";
import type { HostProgramRun } from "../../src/conformance/index.ts";
import { stubHostLibraryPath } from "./world.ts";

const consoleRelayPath = join(import.meta.dirname, "console-relay.ts");
const runningChildren = new Set<ChildProcess>();

/** Kills every child still running, as one whose run outlived its bound is. */
export function killEveryChild(): void {
  for (const child of runningChildren) {
    child.kill("SIGKILL");
  }
  runningChildren.clear();
}

interface ChildProgram {
  readonly child: ChildProcess;
  /** Sends the program its stop request through its platform's terminate signals. */
  readonly requestStop: () => void;
}

/** On POSIX the program is the child, and SIGTERM is its stop request. */
function spawnPosix(programArguments: readonly string[]): ChildProgram {
  const child = spawn(process.execPath, programArguments, { stdio: ["ignore", "ignore", "pipe"] });
  return { child, requestStop: () => child.kill("SIGTERM") };
}

/** On Windows the program runs under `console-relay.ts`, which sends it SIGBREAK when a line reaches its stdin. */
function spawnWindows(programArguments: readonly string[]): ChildProgram {
  const child = spawn(process.execPath, [consoleRelayPath, process.execPath, ...programArguments], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  return { child, requestStop: () => child.stdin?.write("stop\n") };
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
