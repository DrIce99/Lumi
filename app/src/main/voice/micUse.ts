// Which other apps are using the microphone right now (a call): Windows
// records it in the privacy store (CapabilityAccessManager): an app whose
// LastUsedTimeStop is 0 is still recording. The wake word stays off then,
// so a call doesn't wake Lumi by mistake. Read with `reg query` in a child
// process, never blocking the main thread.
import { execFile } from "node:child_process";

export const MIC_STORE = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";

export interface MicUser {
  /** Executable path for desktop apps, package name for Store apps. */
  id: string;
  /** "Discord.exe", or the package name. */
  name: string;
}

/** Apps recording now, from `reg query <MIC_STORE> /s`. */
export function parseMicUse(output: string): MicUser[] {
  const users: MicUser[] = [];
  let key = "";
  let start = "";
  let stop = "";
  const flush = () => {
    if (key && start && start !== "0x0" && stop === "0x0") {
      const last = key.split("\\").pop() ?? key;
      // Desktop apps are stored under NonPackaged with "#" in place of "\"
      const id = key.includes("\\NonPackaged\\") ? last.replace(/#/g, "\\") : last;
      users.push({ id, name: id.split("\\").pop() ?? id });
    }
    key = start = stop = "";
  };
  for (const line of output.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) {
      flush();
      key = line.trim();
      continue;
    }
    const m = /^\s+(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+(0x[0-9a-f]+)/i.exec(line);
    if (m) {
      if (m[1].toLowerCase() === "lastusedtimestart") start = m[2].toLowerCase();
      else stop = m[2].toLowerCase();
    }
  }
  flush();
  return users;
}

/**
 * Apps in a call: recording, but not Lumi itself (`ownExe`) nor the apps
 * Lumi listens to (`allowed`, e.g. Discord: there the wake word is how the
 * user talks to Lumi during the call).
 */
export function otherMicUsers(users: MicUser[], ownExe: string, allowed: string[]): MicUser[] {
  const own = ownExe.toLowerCase();
  const ok = allowed.map((a) => a.toLowerCase().replace(/\.exe$/, ""));
  return users.filter((u) => u.id.toLowerCase() !== own && !ok.includes(u.name.toLowerCase().replace(/\.exe$/, "")));
}

export function readMicUse(): Promise<MicUser[]> {
  if (process.platform !== "win32") return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile("reg", ["query", MIC_STORE, "/s"], { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? [] : parseMicUse(stdout));
    });
  });
}
