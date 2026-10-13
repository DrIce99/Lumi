// The perception summary for the brain: the active app and window, the
// focused field and the line being typed, the selection, and the latest
// new text read on screen. It enters every prompt, so it stays compact
// (about 1500 characters). Screenshots are never part of it. Pure, tested.

export interface ReadText {
  text: string;
  /** When it was read (ms). */
  at: number;
  /** Where it appeared, e.g. "notifica", "Windows Terminal". */
  where?: string;
}

export interface PerceptionState {
  now: number;
  /** Why perception is paused, or null. */
  paused: string | null;
  app: { process: string; title: string } | null;
  focus: { controlType: string; name: string; line: string | null; selection: string | null; isPassword: boolean } | null;
  /** Newest first. */
  read: ReadText[];
  /** What the eyes are on right now. */
  looking?: string;
}

export const MAX_SUMMARY = 1500;

const APP_NAMES: Record<string, string> = {
  "code.exe": "Visual Studio Code",
  "chrome.exe": "Google Chrome",
  "msedge.exe": "Microsoft Edge",
  "firefox.exe": "Firefox",
  "windowsterminal.exe": "Windows Terminal",
  "explorer.exe": "Esplora file",
  "winword.exe": "Word",
  "excel.exe": "Excel",
  "powerpnt.exe": "PowerPoint",
  "outlook.exe": "Outlook",
  "olk.exe": "Outlook",
  "teams.exe": "Teams",
  "ms-teams.exe": "Teams",
  "slack.exe": "Slack",
  "discord.exe": "Discord",
  "whatsapp.exe": "WhatsApp",
  "telegram.exe": "Telegram",
  "notepad.exe": "Blocco note",
  "spotify.exe": "Spotify",
};

export function appName(process: string): string {
  return APP_NAMES[process.toLowerCase()] ?? process.replace(/\.exe$/i, "");
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
}

export function perceptionSummary(state: PerceptionState, maxChars = MAX_SUMMARY): string {
  if (state.paused) return `(screen perception paused: ${state.paused})`;
  const out: string[] = [];
  if (state.app) out.push(`Active app: ${appName(state.app.process)}${state.app.title ? ` - window "${clip(state.app.title, 120)}"` : ""}`);
  const f = state.focus;
  if (f) {
    if (f.isPassword) out.push("Focus: a password field (its content is never read)");
    else {
      out.push(`Focus: ${f.controlType || "element"}${f.name ? ` "${clip(f.name, 80)}"` : ""}`);
      if (f.line) out.push(`Line where the user is typing: "${clip(f.line, 200)}"`);
      if (f.selection) out.push(`Selected text: "${clip(f.selection, 300)}"`);
    }
  }
  if (state.looking) out.push(`Your eyes are on: ${state.looking}`);
  if (state.read.length) {
    out.push("New text you read on screen (newest first):");
    for (const r of state.read) out.push(`- [${ago(state.now - r.at)}${r.where ? `, ${r.where}` : ""}] "${clip(r.text, 240)}"`);
  }
  // Drop the oldest lines until the summary fits
  let summary = out.join("\n");
  while (summary.length > maxChars && out.length > 1) {
    out.pop();
    summary = out.join("\n");
  }
  return summary.length > maxChars ? `${summary.slice(0, maxChars - 1)}…` : summary;
}
