// The keyboard for type_text / press_keys (roadmap 16.4): key names as the
// model writes them ("ctrl+t", "invio", "alt+tab"), text as Unicode key
// events (any character, whatever the keyboard layout), and the INPUT array
// SendInput takes. Pure, tested; win32.ts sends it.

export const KEYEVENTF_EXTENDEDKEY = 0x1;
export const KEYEVENTF_KEYUP = 0x2;
export const KEYEVENTF_UNICODE = 0x4;

/** One INPUT of type INPUT_KEYBOARD. */
export interface KeyEvent {
  vk: number;
  scan: number;
  flags: number;
}

export interface KeyCombo {
  /** Normalized, for the policy and the log: "ctrl+shift+t", "enter". */
  label: string;
  mods: number[];
  key: number;
}

const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_MENU = 0x12;
const VK_LWIN = 0x5b;
export const VK_RETURN = 0x0d;

const MODIFIERS: Record<string, { vk: number; label: string }> = {
  ctrl: { vk: VK_CONTROL, label: "ctrl" },
  control: { vk: VK_CONTROL, label: "ctrl" },
  ctl: { vk: VK_CONTROL, label: "ctrl" },
  shift: { vk: VK_SHIFT, label: "shift" },
  maiusc: { vk: VK_SHIFT, label: "shift" },
  alt: { vk: VK_MENU, label: "alt" },
  win: { vk: VK_LWIN, label: "win" },
  windows: { vk: VK_LWIN, label: "win" },
  super: { vk: VK_LWIN, label: "win" },
  cmd: { vk: VK_LWIN, label: "win" },
};
const MOD_ORDER = ["ctrl", "shift", "alt", "win"];

/** Key names, English and Italian, to virtual keys and their label. */
const NAMED: Record<string, { vk: number; label: string }> = {};
const name = (vk: number, label: string, ...aliases: string[]) => {
  for (const a of [label, ...aliases]) NAMED[a] = { vk, label };
};
name(0x0d, "enter", "invio", "return", "a capo");
name(0x09, "tab", "tabulazione");
name(0x1b, "esc", "escape");
name(0x08, "backspace", "indietro", "cancella indietro");
name(0x2e, "delete", "del", "canc", "elimina");
name(0x2d, "insert", "ins");
name(0x24, "home", "inizio");
name(0x23, "end", "fine");
name(0x21, "pageup", "pagsu", "pag su", "page up");
name(0x22, "pagedown", "paggiu", "pag giu", "page down");
name(0x26, "up", "su", "freccia su", "arrowup");
name(0x28, "down", "giu", "freccia giu", "arrowdown");
name(0x25, "left", "sinistra", "freccia sinistra", "arrowleft");
name(0x27, "right", "destra", "freccia destra", "arrowright");
name(0x20, "space", "spazio", "barra spaziatrice");
name(0x5d, "menu", "apps", "contextmenu");
name(0x2c, "printscreen", "stamp", "prtsc");
for (let i = 1; i <= 24; i++) name(0x6f + i, `f${i}`);

/** These need KEYEVENTF_EXTENDEDKEY, or they arrive as their numeric keypad twins. */
const EXTENDED = new Set([0x2d, 0x2e, 0x24, 0x23, 0x21, 0x22, 0x26, 0x28, 0x25, 0x27, 0x5b, 0x5d, 0x2c]);

/** At most this many combinations per call. */
export const MAX_COMBOS = 10;

/** One combination: "ctrl+shift+t", "Alt + F4", "invio"; null when a part is unknown. */
export function parseCombo(text: string): KeyCombo | null {
  const parts = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .split("+")
    .map((p) => p.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  if (!parts.length) return null;
  const mods = new Set<string>();
  let key: { vk: number; label: string } | null = null;
  for (const [i, part] of parts.entries()) {
    const mod = MODIFIERS[part];
    if (mod && i < parts.length - 1) {
      mods.add(mod.label);
      continue;
    }
    if (key) return null;
    if (mod) key = { vk: mod.vk, label: mod.label };
    else if (NAMED[part]) key = NAMED[part];
    else if (/^[a-z0-9]$/.test(part)) key = { vk: part.toUpperCase().charCodeAt(0), label: part };
    else return null;
  }
  if (!key) return null;
  const ordered = MOD_ORDER.filter((m) => mods.has(m));
  return { label: [...ordered, key.label].join("+"), mods: ordered.map((m) => MODIFIERS[m].vk), key: key.vk };
}

/** Several combinations, separated by spaces or commas ("ctrl+a ctrl+c", "tab, tab, invio"). */
export function parseKeys(text: string): KeyCombo[] | null {
  const combos: KeyCombo[] = [];
  for (const chunk of text.split(",")) {
    const tokens = chunk.trim().replace(/\s*\+\s*/g, "+").split(/\s+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      // Two-word names first: "freccia su", "pag giu", "a capo"
      const two = i + 1 < tokens.length ? parseCombo(`${tokens[i]} ${tokens[i + 1]}`) : null;
      if (two) {
        combos.push(two);
        i++;
        continue;
      }
      const one = parseCombo(tokens[i]);
      if (!one) return null;
      combos.push(one);
    }
  }
  return combos.length && combos.length <= MAX_COMBOS ? combos : null;
}

const press = (vk: number, up: boolean): KeyEvent => ({ vk, scan: 0, flags: (EXTENDED.has(vk) ? KEYEVENTF_EXTENDEDKEY : 0) | (up ? KEYEVENTF_KEYUP : 0) });

/** Modifiers down, the key down and up, modifiers up in reverse. */
export function comboEvents(combo: KeyCombo): KeyEvent[] {
  return [...combo.mods.map((m) => press(m, false)), press(combo.key, false), press(combo.key, true), ...[...combo.mods].reverse().map((m) => press(m, true))];
}

/**
 * Text as Unicode key events (one UTF-16 unit each: emoji's surrogate pairs
 * go as two). A new line is Shift+Enter, which starts a new line in chat
 * apps instead of sending, and is a plain line break elsewhere.
 */
export function textEvents(text: string): KeyEvent[] {
  const out: KeyEvent[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  lines.forEach((line, i) => {
    if (i > 0) out.push(...comboEvents({ label: "shift+enter", mods: [VK_SHIFT], key: VK_RETURN }));
    for (let j = 0; j < line.length; j++) {
      const unit = line.charCodeAt(j);
      if (unit === 9) {
        out.push(press(0x09, false), press(0x09, true));
        continue;
      }
      out.push({ vk: 0, scan: unit, flags: KEYEVENTF_UNICODE }, { vk: 0, scan: unit, flags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP });
    }
  });
  return out;
}

/** sizeof(INPUT) on x64: type + padding, then the union (MOUSEINPUT is the largest, 32 bytes). */
export const INPUT_SIZE = 40;
const INPUT_KEYBOARD = 1;

/** The INPUT array for SendInput: KEYBDINPUT { wVk, wScan, dwFlags, time, dwExtraInfo } at offset 8. */
export function encodeInputs(events: KeyEvent[]): Buffer {
  const buffer = Buffer.alloc(events.length * INPUT_SIZE);
  events.forEach((e, i) => {
    const at = i * INPUT_SIZE;
    buffer.writeUInt32LE(INPUT_KEYBOARD, at);
    buffer.writeUInt16LE(e.vk, at + 8);
    buffer.writeUInt16LE(e.scan, at + 10);
    buffer.writeUInt32LE(e.flags, at + 12);
  });
  return buffer;
}

/** Whether the field's text (the line at the caret, from UI Automation) shows what was typed: its last words. */
export function showsTyped(line: string | null, typed: string): boolean | null {
  if (line === null) return null;
  const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const tail = squash(typed.split("\n").pop() ?? "").slice(-24);
  return tail.length === 0 || squash(line).includes(tail);
}
