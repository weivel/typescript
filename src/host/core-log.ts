import { LogLevel, type LogEvent } from "../core/index.js";
import type { Logger } from "../context/index.js";

/** Writes a log the core queued to the host's logger at the level the core gave it. */
export function writeCoreLog(log: Logger, event: LogEvent): void {
  const text = event.text ?? "";
  switch (event.level) {
    case LogLevel.Debug:
      log.debug(text);
      return;
    case LogLevel.Warning:
      log.warn(text);
      return;
    case LogLevel.Error:
      log.error(text);
      return;
    default:
      log.info(text);
  }
}
