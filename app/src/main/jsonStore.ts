// Small JSON persistence helpers with atomic writes.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { log } from "./log";

export function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (err) {
    // Keep the unreadable file for inspection instead of silently losing it
    const backup = `${file}.corrupt-${Date.now()}`;
    log.error(`Unreadable ${file}, moved to ${backup}`, err);
    try {
      renameSync(file, backup);
    } catch {
      // ignore
    }
    return null;
  }
}

export function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, file);
}

/** Coalesces frequent saves into one write after `delayMs`. */
export class DebouncedWriter {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly file: string,
    private readonly snapshot: () => unknown,
    private readonly delayMs = 500,
  ) {}

  schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      writeJson(this.file, this.snapshot());
    } catch (err) {
      log.error(`Cannot save ${this.file}`, err);
    }
  }
}
