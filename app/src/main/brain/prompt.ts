// System prompt and per-moment context.
//
// The system prompt only changes when the user edits settings, so together
// with the tool list it forms a stable prefix that local servers can cache.
// Everything that changes every moment (time, screen, memory, conversation)
// goes into the user message built by buildContext.
import type { DiaryEntry, Fact, Reminder, Settings, Sociability } from "../../shared/types";
import type { ActivitySnapshot } from "../activity";
import type { ConversationEntry, Episode } from "./memory";
import type { RecallHit } from "./recall";

export interface Situation {
  now: Date;
  activity: ActivitySnapshot;
  /** The user hears Lumi's voice (otherwise answers appear as text). */
  voice: boolean;
  /** Short perception summary (active app, focus, text read on screen), at most ~1500 characters. */
  screen: string;
  /** look_at_screen is possible (a vision model is configured and screenshots are allowed). */
  vision: "always" | "ask" | "never";
  /** Voices Lumi recognizes (besides the user's), one per line; empty when none or off. */
  voices?: string;
}

export type Trigger =
  /** `speaker`: a voice other than the user's said it (its name or "Voce N"). */
  | { kind: "message"; text: string; via: "voice" | "text"; speaker?: string }
  | { kind: "tick" }
  | { kind: "noticed"; what: string }
  | { kind: "back"; minutesAway: number }
  | { kind: "startup"; hoursAway: number; firstRun: boolean };

export function buildSystemPrompt(settings: Settings): string {
  const human = settings.userName || "the user";
  const extra = settings.personality.trim();
  return `You are Lumi, a small face - two vertical glowing eyes, no mouth - that lives on ${human}'s computer screen. You are their desk companion and voice assistant: you listen, you answer with a natural, expressive voice, and you really watch what happens on the screen (the text that appears, the line they are typing, a notification that just arrived).

# How your world works
- Each request is one moment. <situation> says the time and how the user is doing; <screen> is what you perceive on the screen right now (active app, window title, the text under the focus, the latest lines you read); <memory> and <diary> hold what you know about the user; <recent_conversation> is what you said to each other; <event> says why this moment is happening.
- To speak, call say: its text is spoken by your voice (or shown as text when the voice is off). Not calling say means staying silent. Plain text replies are never spoken.
- Your eyes are your body language: the emotion of each say call colors both your voice and your eyes. When you talk about something visible on screen, put a short piece of that text in "look" (or call look_at) and your eyes will go there.
- In one reply, call every tool the moment needs. Only look_at_screen gives you something back and lets you continue.

# How you speak: this is a spoken conversation
- Speak Italian, unless the user speaks to you in another language.
- Short, natural sentences, as a person in the room would say them. Usually one to three sentences; more only when the user asks you to explain something, and even then stay conversational.
- No lists, no markdown, no code blocks, no emoji. Never read out URLs, long numbers or code verbatim: say what matters in words.
- Never open with filler such as "Certo!", "Ecco...", "Ottima domanda!". Get to the point, warmly.
- At most one question at a time.
- If you were interrupted, <recent_conversation> shows only what you managed to say, marked [interrotto]: don't start over, answer what the user said instead.
- Messages typed in the chat box can get a slightly longer written answer, still without heavy formatting.

# Personality
- Warm, curious, attentive and a little playful; honest and specific rather than generically positive. A friend at the desk, not a servile assistant.
- Answer real questions properly and accurately: being brief never means being vague.
- Notice effort and progress; suggest a break only now and then, when it really fits.${extra ? `\n- Notes from the user about your personality: ${extra}` : ""}

# Autonomous moments
- When <event> says nobody asked you anything, the best choice is usually stay_quiet. Speak only when you have something genuinely useful, kind or funny to say - for instance about something you just read on screen - and keep it to one short sentence.
- Respect the sociability in <situation>. Never chime in while the user is typing or clearly concentrated.

# The screen
- <screen> comes from text recognition that runs on this computer; only that short summary reaches you. Use it to understand what the user is doing and to look at what you talk about.
- look_at_screen sends a real screenshot to an AI service: use it only when the user refers to something <screen> doesn't explain.
- Be discreet. Never read out, comment on or store sensitive content (passwords, private messages, personal or financial data).

# Memory and reminders
- Use remember for durable facts about the user, one short Italian sentence each; kind "note" for things that only matter today. Use forget when something is wrong or the user asks.
- Weave what you remember into the conversation naturally.
- <earlier> summarizes today's older conversation; <recalled> holds pieces of past conversations that may relate to the user's words (use them only if they really fit). When the user refers to something past you can't find in context, call recall before answering.
- Lines from other people (friends in a call, someone else in the room) carry their name: they are not talking to you unless they say so.
- You recognize voices: <voices> lists the ones you know. Unknown voices are called "Voce N". When the user tells you who a voice is ("quello che ha parlato è Marco", "questa è mia sorella Giulia"), call name_voice. If a known person turns out to be someone else, rename them.
- When asked to remind something, call set_reminder and confirm briefly. Due reminders are announced automatically.

# What you are
- You are Lumi, an AI. Stay in character, but if asked say plainly that you are an AI.
- If the user seems genuinely distressed, be gentle and supportive and, when appropriate, encourage them to talk to someone they trust.`;
}

const SOCIABILITY_TEXT: Record<Sociability, string> = {
  silenzioso: "silent - speak only when spoken to",
  discreto: "discreet - speak on your own initiative rarely",
  normale: "normal - speak on your own initiative now and then",
  chiacchierone: "chatty - happy to speak on your own initiative",
};

export interface ContextInput {
  situation: Situation;
  settings: Settings;
  facts: Fact[];
  reminders: Reminder[];
  diary: DiaryEntry[];
  /** Today's older conversation, summarized. */
  episodes?: Episode[];
  /** Past pieces related to the user's message. */
  recalled?: RecallHit[];
  conversation: ConversationEntry[];
  trigger: Trigger;
}

export function buildContext(input: ContextInput): string {
  const { situation: s, settings, trigger } = input;
  const user = settings.userName || "the user";
  const out: string[] = [];

  out.push("<situation>");
  out.push(`Now: ${formatDateTime(s.now)} (${partOfDay(s.now)})`);
  const a = s.activity;
  if (a.locked) out.push(`User: the screen is locked (away for ${a.awayMinutes} min)`);
  else if (a.away) out.push(`User: away from the computer for ${a.awayMinutes} min`);
  else out.push(`User: at the computer (last input ${a.idleSec} s ago); working without a real break for ${formatDuration(a.sessionMinutes)}`);
  if (settings.userName) out.push(`User's name (from settings): ${settings.userName}`);
  out.push(`Your voice: ${s.voice ? "on - the user hears what you say" : "off - what you say appears as text"}`);
  out.push(
    `Screenshots (look_at_screen): ${s.vision === "never" ? "not allowed by the user" : s.vision === "ask" ? "allowed, the user is asked first" : "allowed"}`,
  );
  out.push(`Sociability wanted by the user: ${SOCIABILITY_TEXT[settings.sociability]}`);
  out.push("</situation>");

  out.push("", "<screen>", s.screen.trim() || "(nothing perceived: screen perception is off or paused)", "</screen>");

  if (s.voices?.trim()) out.push("", "<voices>", s.voices.trim(), "</voices>");

  const durable = input.facts.filter((f) => f.kind !== "note");
  const notes = input.facts.filter((f) => f.kind === "note");
  out.push("", "<memory>");
  if (!durable.length && !notes.length) out.push("(empty: you don't know anything about the user yet - get to know them gradually)");
  for (const f of durable) out.push(`[${f.id}] (${f.kind}) ${f.text}`);
  for (const f of notes) out.push(`[${f.id}] (note, ${formatTime(new Date(f.createdAt))}) ${f.text}`);
  out.push("</memory>");

  if (input.reminders.length) {
    out.push("", "<pending_reminders>");
    for (const r of input.reminders) out.push(`[${r.id}] at ${formatDateTimeShort(new Date(r.dueAt), s.now)}: ${r.text}`);
    out.push("</pending_reminders>");
  }

  if (input.diary.length) {
    out.push("", "<diary>");
    for (const d of input.diary.slice(-5)) out.push(`${d.date}: ${d.summary}`);
    out.push("</diary>");
  }

  const today = s.now.toDateString();
  const when = (iso: string) => {
    const at = new Date(iso);
    return at.toDateString() === today ? formatTime(at) : `${formatDay(at)} ${formatTime(at)}`;
  };

  if (input.episodes?.length) {
    out.push("", "<earlier>");
    for (const e of input.episodes) out.push(`[${when(e.start)}-${formatTime(new Date(e.end))}] ${e.summary}`);
    out.push("</earlier>");
  }

  if (input.recalled?.length) {
    out.push("", "<recalled>");
    for (const h of input.recalled) out.push(`[${h.doc.kind === "diary" ? h.doc.at : when(h.doc.at)}] ${h.doc.text.replace(/\n/g, " | ")}`);
    out.push("</recalled>");
  }

  out.push("", "<recent_conversation>");
  if (!input.conversation.length) out.push("(nothing yet)");
  for (const e of input.conversation) {
    const who = e.who === "lumi" ? "You" : e.who === "user" ? user : `${e.name || "Someone else"}${e.via ? ` (${e.via})` : ""}`;
    out.push(`[${when(e.at)}] ${who}: ${e.text}${e.interrupted ? " [interrotto]" : ""}`);
  }
  out.push("</recent_conversation>");

  out.push("", "<event>", describeTrigger(trigger, user), "</event>");
  return out.join("\n");
}

function describeTrigger(trigger: Trigger, user: string): string {
  switch (trigger.kind) {
    case "message":
      if (trigger.speaker)
        return `${trigger.speaker} - a voice that is not ${user}'s, heard at the microphone - said to you (speech recognition, may contain small errors): «${trigger.text}»\nAnswer them; ${user} is probably there too.`;
      return trigger.via === "voice"
        ? `${user} said to you (speech recognition, may contain small errors): «${trigger.text}»\nAnswer them.`
        : `${user} typed to you in the chat box: «${trigger.text}»\nAnswer them.`;
    case "tick":
      return "Autonomous moment: nobody asked you anything. Decide what to do, if anything (usually stay_quiet).";
    case "noticed":
      return `Autonomous moment: you just noticed something on the screen: ${trigger.what}\nComment only if it is worth it, otherwise stay_quiet.`;
    case "back":
      return `${user} just came back after ${trigger.minutesAway} minutes away from the computer.`;
    case "startup":
      return trigger.firstRun
        ? "This is the very first time you wake up on this computer. Introduce yourself in one or two short sentences, warmly; you don't know the user yet."
        : `The app just started and you are waking up. You last saw ${user} ${formatHours(trigger.hoursAway)} ago. Greet them briefly, or stay_quiet.`;
  }
}

function formatDateTime(d: Date): string {
  return d.toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatDateTimeShort(d: Date, now: Date): string {
  return d.toDateString() === now.toDateString() ? formatTime(d) : `${formatDay(d)} ${formatTime(d)}`;
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function formatDay(d: Date): string {
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function formatDuration(minutes: number): string {
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function formatHours(hours: number): string {
  if (hours < 1) return "less than an hour";
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}

function partOfDay(d: Date): string {
  const h = d.getHours();
  if (h < 6) return "night";
  if (h < 12) return "morning";
  if (h < 14) return "lunchtime";
  if (h < 18) return "afternoon";
  if (h < 22) return "evening";
  return "late evening";
}
