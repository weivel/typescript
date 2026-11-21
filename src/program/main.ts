import { failedRunExit, type RunHostOptions } from "./model.js";
import { runHost } from "./run.js";

/** The signals a platform asks a program to end by, each mapped onto the run's stop request. */
export function terminateSignals(platform: NodeJS.Platform = process.platform): readonly NodeJS.Signals[] {
  return platform === "win32" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
}

/** setInterval's longest period. */
const longestInterval = 2 ** 31 - 1;

/**
 * The host program's command line, `<host library> <arguments...>`: runs the host library with the arguments after it
 * and answers the code to exit with, each terminate signal of the platform a stop request.
 *
 * @implNote A serve run waiting for a stop request with no tick due holds nothing Node counts as work, a signal
 * listener included, so Node would end the process there; an idle interval keeps it alive until the run ends.
 */
export async function main(commandLine: readonly string[] = process.argv.slice(2), options: Omit<RunHostOptions, "hostLibraryPath" | "arguments" | "signal"> = {}): Promise<number> {
  const [hostLibraryPath, ...programArguments] = commandLine;
  if (hostLibraryPath === undefined) {
    console.error("usage: weivel-host <host library> [arguments...]");
    return failedRunExit;
  }
  const stopRequest = new AbortController();
  const requestStop = (): void => stopRequest.abort();
  const signals = terminateSignals();
  signals.forEach((signal) => process.on(signal, requestStop));
  const keepAlive = setInterval(() => {}, longestInterval);
  try {
    return await runHost({ ...options, hostLibraryPath, arguments: programArguments, signal: stopRequest.signal });
  } finally {
    clearInterval(keepAlive);
    signals.forEach((signal) => process.off(signal, requestStop));
  }
}
