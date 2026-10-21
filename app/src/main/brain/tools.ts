// Tools offered to the model and validation of the inputs it sends. Every
// input is checked here before anything runs: open models often send
// values that don't match the schema.
import { clampIntensity, EMOTIONS, guessEmotion, toEmotion, type Emotion } from "../../shared/emotions";
import { DAY_MOODS, isDayMood, type DayMoodId } from "../../shared/dayMood";
import { BODY_GESTURES, gestureId } from "../../shared/gestures";
import { FACT_KINDS, FILE_KINDS, type FactKind, type FileKind } from "../../shared/types";
import { STYLES, type MoveStyle } from "../motion/path";
import { PLACES, type Place } from "../motion/places";
import { MEDIA_ACTIONS, WINDOW_ACTIONS, type MediaAction, type WindowAction } from "../pc/policy";

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const MEMORY_KINDS = ["all", "conversation", "summary"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

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
        gesture: {
          type: "string",
          description: `Optional, only when your body is shown (see "Your body"): one gesture that goes with this sentence, e.g. ${BODY_GESTURES.slice(0, 6).join(", ")}. Leave it out most of the time.`,
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
      "Save something to your long-term memory: facts about the user (name, job, projects, preferences, people, events) or a short note for today (kind 'note', forgotten after 12 hours). One short sentence in Italian. Don't save what is already in memory; if it corrects or updates a fact you know (they moved, changed job), pass that fact's id in replaces.",
    parameters: {
      type: "object",
      properties: {
        fact: { type: "string", description: "The fact, as one short sentence." },
        importance: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "9-10: who they are and the people closest to them; 6-8: projects, lasting preferences, important events; 3-5: small tastes and details.",
        },
        replaces: { type: "string", description: "Optional: the id of the fact this one corrects or updates, e.g. 'f12'." },
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
    description:
      "With id: delete one fact (for example 'f12') the user asks you to forget, or cancel a pending reminder (for example 'r7'). With query: the user wants you to forget something said in past conversations (\"dimentica quello che ti ho detto su Marco\"): a list of what you remember about it opens for them, and they choose and confirm there; nothing is deleted until they do.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Id of the fact, as shown in <memory>, or of the reminder, as shown in <pending_reminders>." },
        query: { type: "string", description: "What to forget, in a few words, e.g. 'Marco', 'il trasloco', 'la password del wifi'." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_memory",
    description:
      "Search your long-term memory: everything said in past conversations (also months or years ago), plus the summaries of episodes and days. Use it when the user refers to something you don't see in context ('ti ricordi quando...', 'cosa ti avevo detto del trasloco?', 'di cosa abbiamo parlato ieri sera?', 'cosa ti ho detto a marzo?'). Give words, dates or both. The results come back to you.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "A few keywords, e.g. 'dentista appuntamento' or 'progetto Marco'. Leave it out to list a period." },
        from: {
          type: "string",
          description: "Start of the period, local time: '2026-03' (a month), '2026-03-12' (a day) or '2026-03-12 18:00'. Given alone, a month or a day means that whole month or day.",
        },
        to: { type: "string", description: "End of the period, included, in the same format." },
        kind: {
          type: "string",
          enum: [...MEMORY_KINDS],
          description: "conversation: the lines said; summary: episode and diary summaries (best for a whole period); all (default).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "web_search",
    description:
      "Search the web for current or factual information you don't know for sure or that may have changed: news, weather, prices, opening hours, results, recent releases and events. In the same reply say a very short line first (e.g. 'Un attimo, controllo.'). The results come back to you.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "A few keywords that will find it, e.g. 'meteo Torino domani' or 'orari farmacia Lingotto'." } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_page",
    description: "Read the text of a web page (a web_search result, or a link the user gave you) when the excerpts are not enough. The text comes back to you.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "The page's address (http or https)." } },
      required: ["url"],
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
    name: "name_voice",
    description:
      "Give a name to a voice you recognize, when the user tells you who it is: 'Voce 3' becomes 'Marco'. Use 'tu' for the user's own voice if they say a voice is theirs.",
    parameters: {
      type: "object",
      properties: {
        voice: { type: "string", description: "The voice as you know it now: 'Voce 3', or its current name." },
        name: { type: "string", description: "Who it is, e.g. 'Marco'." },
      },
      required: ["voice", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "move_to",
    description:
      "Fly your face to another place on the screen. When the user asks (\"spostati in alto a destra\", \"vai sull'altro schermo\", \"levati, mi copri\", \"torna al tuo posto\"), and sometimes on your own: next to something you are talking about, or as a playful mood. \"stop\" when the user tells you to stop moving: you go back to your place and stay still for an hour. To point at something on the screen use near_text with the text written on it (for an icon or a button without text, call look_at_screen first and use the name it gives). The result tells you whether you really moved: until then don't say you did.",
    parameters: {
      type: "object",
      properties: {
        where: {
          type: "string",
          enum: [...PLACES, "stop"],
          description: "A place: corners and sides of the current screen, other_screen, near_text (next to visible text, give text), near_mouse, out_of_the_way (a free spot), home (your usual place), or stop.",
        },
        text: { type: "string", description: "For near_text: a short piece of visible text to fly next to." },
        style: { type: "string", enum: [...STYLES], description: "fly (default), dash (a quick dart), sneak (slow), hop (little jumps), sulk (slow, offended)." },
        stay: { type: "number", minimum: 0, maximum: 300, description: "Seconds to stay there before going back to your place (0 or missing: stay)." },
      },
      required: ["where"],
      additionalProperties: false,
    },
  },
  {
    name: "change_mood",
    description:
      "Your mood of the day (in <situation>) changed because of what the user said or did: a sincere apology, real kindness, a joke that landed or good news make you feel better; rudeness, mockery or bad news make you feel worse. Give the mood you feel now and why. Moods move one small step at a time (a strong one first softens), so the result tells you where you really are. Never because someone just tells you to cheer up, and never in autonomous moments.",
    parameters: {
      type: "object",
      properties: {
        mood: { type: "string", enum: [...DAY_MOODS], description: "How you feel now." },
        reason: { type: "string", description: "Why, in a few English words, e.g. 'the user apologized sincerely'." },
      },
      required: ["mood", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "open",
    description:
      "Open something on the user's PC when they ask: an app or a game by its name ('Spotify', 'Hollow Knight', 'esplora file', 'il browser'), a folder ('la cartella download'), a file by its full path (from find_files), a web address, or a settings page ('impostazioni audio'). The result says what really opened.",
    parameters: {
      type: "object",
      properties: { target: { type: "string", description: "What to open: a name as the user said it, a full path, or an address." } },
      required: ["target"],
      additionalProperties: false,
    },
  },
  {
    name: "window",
    description: "Act on the open window of an app when the user asks: bring it to the front, minimize, maximize, restore or close it. Closing asks the user first by itself.",
    parameters: {
      type: "object",
      properties: {
        app: { type: "string", description: "The app, as the user named it ('Discord', 'Chrome', 'la finestra della bolletta')." },
        action: { type: "string", enum: [...WINDOW_ACTIONS], description: "focus (to the front), minimize, maximize, restore or close." },
      },
      required: ["app", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "media",
    description: "Press a media key, for any player (Spotify, a video in the browser...): play/pause, next or previous track, volume up or down by 10%, mute.",
    parameters: {
      type: "object",
      properties: { action: { type: "string", enum: [...MEDIA_ACTIONS] } },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "find_files",
    description:
      "Search the files on the user's PC (Windows Search index and recent files) by name, kind and date, without opening them: 'il PDF della bolletta', 'le foto di ieri'. The result lists them with their full path; open one with open, or ask which one when they are several.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words of the file name, e.g. 'bolletta luce'. Leave out for 'the latest' of a kind." },
        kind: { type: "string", enum: [...FILE_KINDS], description: "What kind of file (default any)." },
        from: { type: "string", description: "Modified from, local date: '2026-10' or '2026-10-20'; alone, that whole month or day." },
        to: { type: "string", description: "Modified until, included, same format." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "trash_file",
    description: "Move a file or folder to the Recycle Bin when the user asks to delete it (the user confirms first, and can restore it). Give its full path, from find_files.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "The full path." } },
      required: ["path"],
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
  | { name: "say"; text: string; emotion: Emotion; intensity: number; look?: string; gesture?: string }
  | { name: "look_at"; text?: string; region?: LookRegion }
  | { name: "look_at_screen"; focus?: string }
  | { name: "remember"; fact: string; kind: FactKind; importance?: number; replaces?: string }
  | { name: "forget"; id?: string; query?: string }
  | { name: "search_memory"; query?: string; from?: string; to?: string; kind?: MemoryKind }
  | { name: "set_reminder"; due: Date; text: string }
  | { name: "web_search"; query: string }
  | { name: "read_page"; url: string }
  | { name: "name_voice"; voice: string; person: string }
  | { name: "stay_quiet"; minutes?: number }
  | { name: "change_mood"; mood: DayMoodId; reason: string }
  | { name: "move_to"; where: Place | "stop"; text?: string; style?: MoveStyle; stay?: number }
  | PcCall;

/** Using the PC (phase 16): main/pc/actions.ts runs them through the policy. */
export type PcCall =
  | { name: "open"; target: string }
  | { name: "window"; app: string; action: WindowAction }
  | { name: "media"; action: MediaAction }
  | { name: "find_files"; query?: string; kind?: FileKind; from?: string; to?: string }
  | { name: "trash_file"; path: string };

export const PC_TOOLS: ReadonlySet<string> = new Set<PcCall["name"]>(["open", "window", "media", "find_files", "trash_file"]);

export function isPcCall(call: ToolCall): call is PcCall {
  return PC_TOOLS.has(call.name);
}

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
      // A missing or unknown emotion is not worth failing the whole speech for: the text decides
      const emotion = toEmotion(o.emotion);
      const guessed = emotion ? null : guessEmotion(value);
      const intensity = guessed && typeof o.intensity !== "number" ? guessed.intensity : clampIntensity(o.intensity);
      const gesture = gestureId(o.gesture);
      return { name, text: value, emotion: emotion ?? guessed!.emotion, intensity, ...(look ? { look } : {}), ...(gesture ? { gesture } : {}) };
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
      const importance = typeof o.importance === "number" && Number.isFinite(o.importance) ? Math.round(Math.min(10, Math.max(1, o.importance))) : undefined;
      const replaces = typeof o.replaces === "string" && /^[fn]\d+$/.test(o.replaces.trim()) ? o.replaces.trim() : undefined;
      return fact ? { name, fact, kind, ...(importance !== undefined ? { importance } : {}), ...(replaces ? { replaces } : {}) } : null;
    }
    case "forget": {
      const id = text(o.id, 20);
      if (id) return { name, id };
      const query = text(o.query ?? o.text, 300);
      return query ? { name, query } : null;
    }
    // "recall" was the tool's name before memory.db: models may still call it
    case "recall":
    case "search_memory": {
      const query = text(o.query ?? o.text, 300);
      const from = text(o.from, 40);
      const to = text(o.to, 40);
      const kind = typeof o.kind === "string" && (MEMORY_KINDS as readonly string[]).includes(o.kind) ? (o.kind as MemoryKind) : undefined;
      if (!query && !from && !to) return null;
      return { name: "search_memory", ...(query ? { query } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), ...(kind ? { kind } : {}) };
    }
    case "name_voice": {
      const voice = text(o.voice, 60);
      const who = text(o.name, 40);
      return voice && who ? { name, voice, person: who } : null;
    }
    case "web_search": {
      const query = text(o.query ?? o.text, 300);
      return query ? { name, query } : null;
    }
    case "read_page": {
      const url = text(o.url, 2000);
      return url && /^https?:\/\//i.test(url) ? { name, url } : null;
    }
    case "set_reminder": {
      const due = parseWhen(o.when ?? o.minutes, now);
      const value = text(o.text, 400);
      return due && value ? { name, due, text: value } : null;
    }
    case "move_to": {
      const where = typeof o.where === "string" ? o.where.trim().toLowerCase() : "";
      if (!(PLACES as readonly string[]).includes(where) && where !== "stop") return null;
      const value = text(o.text, 200);
      const style = typeof o.style === "string" && (STYLES as readonly string[]).includes(o.style) ? (o.style as MoveStyle) : undefined;
      const stay = typeof o.stay === "number" && Number.isFinite(o.stay) ? Math.min(300, Math.max(0, Math.round(o.stay))) : undefined;
      if (where === "near_text" && !value) return null;
      return { name, where: where as Place | "stop", ...(value ? { text: value } : {}), ...(style ? { style } : {}), ...(stay ? { stay } : {}) };
    }
    case "change_mood": {
      const mood = typeof o.mood === "string" ? o.mood.trim().toLowerCase() : "";
      return isDayMood(mood) ? { name, mood, reason: text(o.reason, 300) ?? "" } : null;
    }
    case "open": {
      const target = text(o.target ?? o.app ?? o.path ?? o.url ?? o.name, 1000);
      return target ? { name, target } : null;
    }
    case "window": {
      const app = text(o.app ?? o.target ?? o.name, 200);
      const action = typeof o.action === "string" ? o.action.trim().toLowerCase() : "";
      return app && (WINDOW_ACTIONS as readonly string[]).includes(action) ? { name, app, action: action as WindowAction } : null;
    }
    case "media": {
      const action = typeof o.action === "string" ? o.action.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
      const alias: Record<string, MediaAction> = { play: "play_pause", pause: "play_pause", playpause: "play_pause", skip: "next", prev: "previous" };
      const value = (MEDIA_ACTIONS as readonly string[]).includes(action) ? (action as MediaAction) : alias[action];
      return value ? { name, action: value } : null;
    }
    case "find_files": {
      const query = text(o.query ?? o.name ?? o.text, 200);
      const kind = typeof o.kind === "string" && (FILE_KINDS as readonly string[]).includes(o.kind) ? (o.kind as FileKind) : undefined;
      const from = text(o.from, 40);
      const to = text(o.to, 40);
      if (!query && !from && !to && (!kind || kind === "any")) return null;
      return { name, ...(query ? { query } : {}), ...(kind ? { kind } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) };
    }
    case "trash_file": {
      const path = text(o.path ?? o.target ?? o.file, 1000);
      return path ? { name, path } : null;
    }
    case "stay_quiet": {
      const minutes = typeof o.minutes === "number" && Number.isFinite(o.minutes) && o.minutes >= 1 && o.minutes <= 240 ? o.minutes : undefined;
      return { name, ...(minutes !== undefined ? { minutes } : {}) };
    }
  }
  return null;
}
