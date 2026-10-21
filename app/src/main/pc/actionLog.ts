// actions.jsonl: every action Lumi tried on the PC, what it touched, the
// policy's level, whether the user confirmed and how it ended. Shown in the
// settings (tab PC). Never typed text: only names of apps, files and keys.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionRecord } from "../../shared/types";
import { log } from "../log";

/** Lines kept on disk; older ones are dropped at startup. */
const KEEP = 2000;

export class ActionLog {
  private readonly file: string | null;
  private recentList: ActionRecord[] = [];

  constructor(dir: string | null) {
    this.file = dir ? join(dir, "actions.jsonl") : null;
    if (!this.file) return;
    try {
      const lines = readFileSync(this.file, "utf8").split("\n").filter(Boolean);
      if (lines.length > KEEP) writeFileSync(this.file, `${lines.slice(-KEEP).join("\n")}\n`);
      this.recentList = lines.slice(-50).flatMap((line) => {
        try {
          return [JSON.parse(line) as ActionRecord];
        } catch {
          return [];
        }
      });
    } catch {
      // no log yet
    }
  }

  add(record: ActionRecord): void {
    this.recentList = [...this.recentList.slice(-49), record];
    log.info(`PC action: ${record.tool}${record.action ? ` ${record.action}` : ""} -> ${record.outcome} (${record.level}${record.confirmed !== undefined ? `, confirmed: ${record.confirmed}` : ""})`);
    if (!this.file) return;
    try {
      appendFileSync(this.file, `${JSON.stringify(record)}\n`);
    } catch (err) {
      log.warn("Writing actions.jsonl failed", err);
    }
  }

  /** The latest actions, newest first. */
  recent(n = 30): ActionRecord[] {
    return this.recentList.slice(-n).reverse();
  }
}
