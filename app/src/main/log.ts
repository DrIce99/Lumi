// Minimal logger: console plus a rolling file in the app data folder.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_LOG_BYTES = 2_000_000;
let logFile: string | null = null;
let consoleOutput = true;

export function initLog(dir: string): void {
  mkdirSync(dir, { recursive: true });
  logFile = join(dir, "lumi.log");
  try {
    if (statSync(logFile).size > MAX_LOG_BYTES) renameSync(logFile, join(dir, "lumi.old.log"));
  } catch {
    // no log yet
  }
}

/** Stops echoing to the console (tests that trigger expected errors). */
export function muteConsole(): void {
  consoleOutput = false;
}

/** Perception text (OCR, UI Automation) may be logged only when this is on. */
export const DEBUG_PERCEPTION = process.env.LUMI_DEBUG_PERCEPTION === "1";

function write(level: string, args: unknown[]): void {
  const text = args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const line = `${new Date().toISOString()} ${level} ${text}`;
  if (consoleOutput) {
    if (level === "ERROR") console.error(line);
    else console.log(line);
  }
  if (logFile) {
    try {
      appendFileSync(logFile, line + "\n");
    } catch {
      // logging must never crash the app
    }
  }
}

export const log = {
  info: (...args: unknown[]) => write("INFO", args),
  warn: (...args: unknown[]) => write("WARN", args),
  error: (...args: unknown[]) => write("ERROR", args),
  /** Lines that contain screen or speech content: dropped unless LUMI_DEBUG_PERCEPTION=1. */
  perception: (...args: unknown[]) => {
    if (DEBUG_PERCEPTION) write("PERC", args);
  },
};
