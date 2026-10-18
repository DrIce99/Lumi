// Text helpers shared by the providers: partial JSON reading, thinking
// removal, and the JSON reply format for models without tool support.
import { EMOTIONS } from "../../../shared/emotions";
import { DAY_MOODS } from "../../../shared/dayMood";
import { FACT_KINDS } from "../../../shared/types";
import type { LiveSay, ToolCallOut } from "./types";

const JSON_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };

/** Reads the possibly unterminated string value of `key` from a JSON prefix such as `{"text": "Ciao! Co`. */
export function partialStringField(json: string, key: string): string | null {
  const start = new RegExp(`"${key}"\\s*:\\s*"`).exec(json);
  if (!start) return null;
  let out = "";
  for (let i = start.index + start[0].length; i < json.length; i++) {
    const ch = json[i];
    if (ch === '"') return out;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = json[i + 1];
    // An escape split across two fragments is completed by the next one
    if (next === undefined) return out;
    if (next === "u") {
      const hex = json.slice(i + 2, i + 6);
      if (hex.length < 4) return out;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
    } else {
      out += JSON_ESCAPES[next] ?? next;
      i++;
    }
  }
  return out;
}

/** Whether the string value of `key` is complete (its closing quote arrived). */
export function stringFieldComplete(json: string, key: string): boolean {
  const start = new RegExp(`"${key}"\\s*:\\s*"`).exec(json);
  if (!start) return false;
  for (let i = start.index + start[0].length; i < json.length; i++) {
    if (json[i] === "\\") i++;
    else if (json[i] === '"') return true;
  }
  return false;
}

/** Reads a complete number value of `key`, or null. */
export function numberField(json: string, key: string): number | null {
  const m = new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)\\s*[,}\\s]`).exec(json);
  return m ? Number(m[1]) : null;
}

/** A say call (or the JSON reply) as written so far. */
export function liveSayFrom(json: string, textKey: string, complete: boolean): LiveSay | null {
  const text = partialStringField(json, textKey);
  if (text === null) return null;
  const emotion = stringFieldComplete(json, "emotion") ? (partialStringField(json, "emotion") ?? undefined) : undefined;
  const intensity = numberField(json, "intensity") ?? undefined;
  const look = stringFieldComplete(json, "look") ? (partialStringField(json, "look") ?? undefined) : undefined;
  return { text, emotion, intensity, look, complete: complete || stringFieldComplete(json, textKey) };
}

/** Removes reasoning that some open models write inline as <think>...</think>. */
export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<think>[\s\S]*$/, "")
    .trim();
}

/** Instructions appended to the system prompt when the model can't call tools. */
export const JSON_REPLY_FORMAT = `

# Reply format
In this conversation you cannot call tools. Reply ONLY with one JSON object, with no other text and no code fences. Every field is optional and corresponds to the tools described above; write "emotion" before "say":
{"emotion": "${EMOTIONS.join("|")}",
 "intensity": 0.6,
 "look": "visible text you are talking about",
 "say": "what you say out loud (leave it out to stay silent)",
 "look_at": "visible text to look at",
 "remember": [{"fact": "one short sentence", "kind": "${FACT_KINDS.join("|")}"}],
 "forget": ["f12"],
 "reminder": {"when": "+20", "text": "what to remind"},
 "look_at_screen": "what you are looking for",
 "search_memory": "words to look for in your memory",
 "web_search": "words to search on the web",
 "read_page": "https://...",
 "mood": {"mood": "${DAY_MOODS.join("|")}", "reason": "why your mood of the day changed"},
 "quiet_minutes": 30}
"look_at_screen", "search_memory", "web_search" and "read_page" bring something back: you will receive it and reply again.
Example: {"emotion": "gioia", "say": "Ciao! Come va oggi?"}`;

/** Finds the JSON object in a reply, tolerating code fences and stray text. */
function extractObject(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(cleaned.slice(start, end + 1));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Turns a JSON-format reply into the same tool calls a tool-capable model
 * would make. A reply that isn't JSON at all is treated as speech.
 */
export function parseJsonReply(raw: string): ToolCallOut[] {
  const text = stripThinking(raw);
  const o = extractObject(text);
  if (!o) {
    if (!text || text.startsWith("{")) {
      const said = partialStringField(text, "say");
      return said ? [{ id: "json_say", name: "say", input: { text: said, emotion: partialStringField(text, "emotion") ?? "neutra" } }] : [];
    }
    return [{ id: "json_say", name: "say", input: { text, emotion: "neutra" } }];
  }
  const calls: ToolCallOut[] = [];
  let n = 0;
  const add = (name: string, input: unknown) => calls.push({ id: `json_${++n}`, name, input });
  if (typeof o.say === "string" && o.say.trim()) {
    add("say", {
      text: o.say,
      emotion: typeof o.emotion === "string" ? o.emotion : "neutra",
      ...(typeof o.intensity === "number" ? { intensity: o.intensity } : {}),
      ...(typeof o.look === "string" && o.look.trim() ? { look: o.look } : {}),
    });
  }
  if (typeof o.look_at === "string" && o.look_at.trim()) add("look_at", { text: o.look_at });
  if (Array.isArray(o.remember)) for (const item of o.remember) add("remember", typeof item === "string" ? { fact: item } : item);
  if (Array.isArray(o.forget)) for (const id of o.forget) add("forget", { id });
  if (o.reminder && typeof o.reminder === "object") add("set_reminder", o.reminder);
  if (o.look_at_screen) add("look_at_screen", typeof o.look_at_screen === "string" ? { focus: o.look_at_screen } : {});
  if (typeof o.search_memory === "string" && o.search_memory.trim()) add("search_memory", { query: o.search_memory });
  if (typeof o.web_search === "string" && o.web_search.trim()) add("web_search", { query: o.web_search });
  if (typeof o.read_page === "string" && o.read_page.trim()) add("read_page", { url: o.read_page });
  if (o.mood && typeof o.mood === "object") add("change_mood", o.mood);
  if (typeof o.quiet_minutes === "number") add("stay_quiet", { minutes: o.quiet_minutes });
  return calls;
}
