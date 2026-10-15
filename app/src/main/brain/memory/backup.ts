// Daily backups of memory.db: a consistent copy (VACUUM INTO, safe while
// the database is in use) in %APPDATA%\Lumi\backups, one per day, the
// newest `keep` kept. A forget (or "Dimentica tutto") resets them: old
// copies would still hold what was forgotten.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { MemoryDb } from "./db";
import { backupName, backupsToDelete, isBackup } from "./periods";

/** Writes today's backup unless it exists; `reset` first deletes every backup. Returns the new file, or null. */
export function makeBackup(db: MemoryDb, dir: string, keep: number, reset = false, now = new Date()): string | null {
  mkdirSync(dir, { recursive: true });
  if (reset) for (const name of readdirSync(dir)) if (isBackup(name)) rmSync(join(dir, name), { force: true });
  if (keep <= 0) return null;
  const file = join(dir, backupName(now));
  if (existsSync(file)) return null;
  const tmp = `${file}.tmp`;
  rmSync(tmp, { force: true });
  db.backupTo(tmp);
  renameSync(tmp, file);
  for (const old of backupsToDelete(readdirSync(dir), keep)) rmSync(join(dir, old), { force: true });
  return file;
}
