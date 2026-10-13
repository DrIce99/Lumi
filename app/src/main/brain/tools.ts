// Tools offered to the model and validation of the inputs it sends. Every
// input is checked here before anything runs: open models often send
// values that don't match the schema.
import { clampIntensity, EMOTIONS, toEmotion, type Emotion } from "../../shared/emotions";
import { FACT_KINDS, type FactKind } from "../../shared/types";

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const LOOK_REGIONS = ["active_window", "cursor", "caret", "top", "bottom", "left", "right", "center", "user"] as const;
export type LookRegion = (typeof LOOK_REGIONS)[number];

// Order and content stay stable: the tool list is part of the prompt prefix
// that local servers cache. In say, emotion comes before text on purpose:
// models write arguments in schema order, and the voice needs the emotion
// before the first sentence.
export const TOOLS: ToolSpec[] = [
  {
    name: "say",
    description:
      "Speak out loud: this is the only way the user hears you (plain text replies are not spoken). Write the emotion first, then the text. Use one call per thought; several calls are spoken in order.",
    parameters: {
      type: "object",
      properties: {
        emotion: { type: "string", enum: [...EMOTIONS], description: "How you feel while saying it: it colors your voice and your eyes." },
        intensity: { type: "number", minimum: 0, maximum: 1, description: "How strong the emotion is, 0-1 (default 0.6)." },
        look: {
          type: "string",
          description: "Optional: a short piece of text visible on the user's screen (a word, a line, a button label) that you are talking about. Your eyes will look at it while you speak.",
        },
        text: {
          type: "string",
          description: "What you say, as natural spoken Italian: short sentences, no lists, no markdown, no emoji.",
        },
      },
      required: ["emotion", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "look_at",
    description:
      "Turn your eyes to something on the user's screen, without saying anything: a piece of visible text (found among the words you can read on screen) or a region.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Visible text to look at, e.g. a word in an error message." },
        region: { type: "string", enum: [...LOOK_REGIONS], description: "A region to look at when there is no text: the active window, the mouse, the text cursor, a side of the screen, or the user." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "look_at_screen",
    description:
      "Take a screenshot to really see the screen (images, layout, code, anything beyond the text you already read in <screen>). Use it when the user refers to something on screen that <screen> doesn't describe well enough. The result comes back to you.",
    parameters: {
      type: "object",
      properties: {
        focus: { type: "string", description: "Optional: what you are looking for, e.g. 'the error in the terminal'." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "remember",
    description:
      "Save something to your long-term memory: facts about the user (name, job, projects, preferences, people, events) or a short note for today (kind 'note', forgotten after 12 hours). One short sentence in Italian. Don't save what is already in memory.",
    parameters: {
      type: "object",
      properties: {
        fact: { type: "string", description: "The fact, as one short sentence." },
        kind: {
          type: "string",
          enum: [...FACT_KINDS],
          description: "user: who they are. work: job and projects. preference: likes, dislikes, habits. event: something that happened or will happen. lumi: about you and your relationship. note: temporary, for today.",
        },
      },
      required: ["fact"],
      additionalProperties: false,
    },
  },
  {
    name: "forget",
    description: "Delete a memory by id (for example 'f12') when it is wrong or outdated, or when the user asks you to forget it.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Id of the memory, as shown in <memory>." } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "set_reminder",
    description:
      "Schedule a reminder that you will say out loud later, when the user asks ('ricordami tra 20 minuti...', 'alle 15 ho una call'). Confirm briefly with say.",
    parameters: {
      type: "object",
      properties: {
        when: {
          type: "string",
          description: "'+20' for 20 minutes from now, '15:30' for a time today (tomorrow if already past), or a date and time like '2026-10-14 09:00'.",
        },
        text: { type: "string", description: "What to tell the user when it is time, in Italian." },
      },
      required: ["when", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "stay_quiet",
    description:
      "Choose to say nothing now (the best choice in most autonomous moments, and when the user is busy). Optionally, how many minutes to wait before your next autonomous moment.",
    parameters: {
      type: "object",
      properties: { minutes: { type: "number", minimum: 1, maximum: 240, description: "Minutes until your next autonomous moment." } },
      additionalProperties: false,
    },
  },
];

export type ToolCall =
  | { name: "say"; text: string; emotion: Emotion; intensity: number; look?: string }
  | { name: "look_at"; text?: string; region?: LookRegion }
  | { name: "look_at_screen"; focus?: string }
  | { name: "remember"; fact: string; kind: FactKind }
  | { name: "forget"; id: string }
  | { name: "set_reminder"; due: Date; text: string }
  | { name: "stay_quiet"; minutes?: number };

/** Parses `when` ("+20", "20", "15:30", "2026-10-14 09:00") into a date after `now`; null when unreadable. */
export function parseWhen(when: unknown, now: Date): Date | null {
  if (typeof when === "number" && Number.isFinite(when)) return when >= 1 && when <= 10080 ? new Date(now.getTime() + when * 60_000) : null;
  if (typeof when !== "string") return null;
  const s = when.trim().toLowerCase();
  const minutes = /^\+?\s*(\d+(?:[.,]\d+)?)\s*(?:m|min|minuti|minutes)?$/.exec(s);
  if (minutes) {
    const m = Number(minutes[1].replace(",", "."));
    return m >= 1 && m <= 10080 ? new Date(now.getTime() + m * 60_000) : null;
  }
  const hours = /^\+?\s*(\d+(?:[.,]\d+)?)\s*(?:h|ore|ora|hours?)$/.exec(s);
  if (hours) {
    const h = Number(hours[1].replace(",", "."));
    return h > 0 && h <= 168 ? new Date(now.getTime() + h * 3_600_000) : null;
  }
  const time = /^(\d{1,2})[:.](\d{2})$/.exec(s);
  if (time) {
    const h = Number(time[1]);
    const m = Number(time[2]);
    if (h > 23 || m > 59) return null;
    const due = new Date(now);
    due.setHours(h, m, 0, 0);
    if (due.getTime() <= now.getTime()) due.setDate(due.getDate() + 1);
    return due;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})[ t](\d{1,2}):(\d{2})/.exec(s);
  if (iso) {
    const due = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), Number(iso[4]), Number(iso[5]));
    return Number.isFinite(due.getTime()) && due.getTime() > now.getTime() ? due : null;
  }
  return null;
}

/** Validates a tool call against its schema; returns null when the input doesn't match. */
export function parseToolCall(name: string, input: unknown, now = new Date()): ToolCall | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  const text = (value: unknown, max: number): string | null =>
    typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;
  switch (name) {
    case "say": {
      const value = text(o.text, 6000);
      if (!value) return null;
      const look = text(o.look, 200);
      // Unknown emotions are not worth failing the whole speech for
      return { name, text: value, emotion: toEmotion(o.emotion) ?? "neutra", intensity: clampIntensity(o.intensity), ...(look ? { look } : {}) };
    }
    case "look_at": {
      const value = text(o.text, 200);
      const region = typeof o.region === "string" && (LOOK_REGIONS as readonly string[]).includes(o.region) ? (o.region as LookRegion) : undefined;
      if (!value && !region) return null;
      return { name, ...(value ? { text: value } : {}), ...(region ? { region } : {}) };
    }
    case "look_at_screen": {
      const focus = text(o.focus, 300);
      return { name, ...(focus ? { focus } : {}) };
    }
    case "remember": {
      const fact = text(o.fact ?? o.text, 400);
      const kind = typeof o.kind === "string" && (FACT_KINDS as string[]).includes(o.kind) ? (o.kind as FactKind) : "user";
      return fact ? { name, fact, kind } : null;
    }
    case "forget": {
      const id = text(o.id, 20);
      return id ? { name, id } : null;
    }
    case "set_reminder": {
      const due = parseWhen(o.when ?? o.minutes, now);
      const value = text(o.text, 400);
      return due && value ? { name, due, text: value } : null;
    }
    case "stay_quiet": {
      const minutes = typeof o.minutes === "number" && Number.isFinite(o.minutes) && o.minutes >= 1 && o.minutes <= 240 ? o.minutes : undefined;
      return { name, ...(minutes !== undefined ? { minutes } : {}) };
    }
  }
  return null;
}
