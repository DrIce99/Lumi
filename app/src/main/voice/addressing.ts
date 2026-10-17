// Is a heard sentence meant for Lumi? With continuous listening, and for a
// few seconds after every answer, the microphone hears everything: the user
// talking to someone else, to themselves, to a friend in a call. This module
// reads the transcript and decides: "yes" (the name, an answer to Lumi's
// question, a typical request), "no" (a filler, a call to someone else, a
// call with friends) or "maybe", which the model then judges with a small
// prompt (Brain.isAddressed). Pure, tested.
//
// Two signals beyond the words. Who is around: when another voice has been
// answering the user, they are talking to each other; when only the user's
// voice is heard, the user is alone with Lumi (or with themselves). And the
// thread: a sentence that picks up what Lumi and the user were just talking
// about ("e domani?", "quello di prima") is for Lumi, even a minute after her
// last answer, as long as nobody else joins in.
import { distance } from "./wakeWord";

/** How a turn came to be heard: the hotkey and the name are explicit, the rest has to be judged. */
export type Opened = "ptt" | "name" | "barge" | "open" | "followup";

export interface AddressingInput {
  text: string;
  opened: Opened;
  wakeWord: string;
  /** Lumi's last line ended with a question and was said a moment ago. */
  lumiAsked: boolean;
  /** Friends are talking in a call (Discord) or the bot is in the user's voice channel. */
  inCall: boolean;
  /** Other people Lumi knows by name (named voices), not the user. */
  names?: string[];
  /** Seconds since Lumi answered the user (a user line, then Lumi's); null when there is no recent exchange. */
  threadAgo?: number | null;
  /** Another voice than the user's was heard nearby a moment ago (people talking to each other); null: voices aren't recognized. */
  othersHeard?: boolean | null;
  /** This sentence is in another voice than the user's. */
  otherVoice?: boolean;
}

/** An exchange with Lumi is "open" this long after her answer: a sentence that continues it is for her. */
export const THREAD_SECONDS = 90;
/** Up to this long the model still reads the exchange to judge (a longer pause is a new subject). */
export const THREAD_MAX_SECONDS = 300;

export interface Addressing {
  verdict: "yes" | "no" | "maybe";
  reason: string;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}' ]/gu, " ")
    .replace(/'/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Lumi's name as speech recognition writes it: lumi, lumy, lumie, rumi, luomi... */
const NAME = /^(l|r)(u|uo|oo)m(i|y|ie|ia)$/;

/** Short sounds and words that are rarely a request: answers, reactions, laughs. */
const FILLERS = new Set([
  "si", "no", "ok", "okay", "ah", "eh", "oh", "mh", "mhm", "hm", "uhm", "boh", "beh", "mah", "ahah", "ahaha", "haha", "hahaha", "uffa", "ma", "e", "dai", "certo", "ecco", "esatto", "giusto",
  "aspetta", "allora", "cioe", "va", "bene", "ciao", "grazie", "prego", "scusa", "ehi", "wow", "ops", "ahi", "mmh",
]);

/** Said after a greeting, they call someone who is not Lumi. */
const GREETINGS = new Set(["ehi", "ei", "hey", "ciao", "senti", "scusa", "scusate", "ok", "allora", "dai", "oh"]);
const OTHERS = new Set([
  "ragazzi", "raga", "ragà", "gente", "amico", "amici", "bro", "fra", "frate", "bella", "bello", "amore", "tesoro", "mamma", "papa", "nonno", "nonna", "zio", "zia", "ragazze", "tutti", "squadra", "team", "capo", "boss",
]);

/**
 * What a request to an assistant usually starts with. Meant for Lumi only
 * when the user isn't in a call with friends. Generic enough ("che ore
 * sono", "cerca", "apri", "come stai") to skip the model for most requests.
 */
const REQUEST =
  /^(che (ore|ora|giorno|data|tempo|meteo|temperatura|ne pensi|dici|cosa|significa|vuol dire)|che cosa|cosa (vedi|c e|ne pensi|dici|sai|significa|vuol dire|hai|stai|sta|fai|dice|e|sono)|come (stai|va|si dice|si chiama|si scrive|posso|faccio|funziona|ti chiami)|quando (e|sono|esce|finisce|inizia|devo)|dove (sei|si trova|posso|trovo|e|sono)|quanto (fa|costa|manca|dista|e|sono|dura|pesa)|chi (e|sei|ha|era|sono)|perche|qual e|quale|puoi|potresti|riesci|sapresti|mi (dici|dai|trovi|fai|cerchi|leggi|ricordi|spieghi|aiuti|puoi|racconti|traduci|apri|chiudi|passi|metti)|dimmi|dammi|trovami|cercami|cerca|apri|chiudi|metti|leggi|spiegami|raccontami|fammi|ricordami|ricordati|segnati|segna|guarda|controlla|traduci|calcola|imposta|avvia|ferma|spostati|torna|stai (ferma|zitta|attenta|calma)|smettila|basta|silenzio|zitta|cancella|ripeti|continua|riprova|scrivi|salva|cos e|cosa e|a che ora|in che|ti ricordi|ricordi|ci sei|mi senti|mi ascolti|sei (li|qui|la|sveglia|ancora)|hai sentito|che ne dici|dici che)\b/;

/**
 * How a sentence starts when it picks up the last exchange: "e domani?", "invece dopodomani",
 * "quello che hai detto", "ripeti", "come mai?". Only counted while the exchange is open.
 */
const CONTINUATION =
  /^(e|ma|quindi|allora|invece|pero|anche|poi|oppure|ah e|ok e|e se|e quindi|quello|quella|quelli|quelle|questo|questa|questi|queste|dopodomani|domani|stasera|stanotte|ieri|oggi|ancora|di nuovo|un altro|un altra|altri|altre|come mai|davvero|sul serio|sicura|sicuro|in che senso|cioe|spiega|approfondisci|mostrami|fammi vedere|aspetta|no aspetta|ok ma|si ma|ma allora|e per|e con|e dove|e quando|e chi|e come|e quanto|e quale)\b/;

/** A sentence this long without a clear request is more likely a talk than a command. */
const LONG_WORDS = 28;

/**
 * Whether a word is the assistant's name (the last word of the wake word). Stricter than the
 * wake word spotting: "lui" and "luci" are one letter away from "lumi" and common Italian.
 */
function nameMentioned(ws: string[], wakeWord: string): boolean {
  const target = words(wakeWord).pop() ?? "lumi";
  if (NAME.test(target)) return ws.some((w) => NAME.test(w));
  return ws.some((w) => w === target || (target.length >= 6 && w.length >= 5 && distance(w, target) <= 1));
}

/** First words after the greetings ("ehi ragazzi" -> "ragazzi"). */
function afterGreetings(ws: string[]): string[] {
  let i = 0;
  while (i < ws.length - 1 && GREETINGS.has(ws[i])) i++;
  return ws.slice(i);
}

export function classifyAddressing(input: AddressingInput): Addressing {
  const { opened } = input;
  if (opened === "ptt" || opened === "name" || opened === "barge") return { verdict: "yes", reason: "explicit" };
  const ws = words(input.text);
  if (!ws.length) return { verdict: "no", reason: "empty" };
  if (nameMentioned(ws, input.wakeWord)) return { verdict: "yes", reason: "name" };

  const shortAnswer = ws.length <= 2 && ws.every((w) => FILLERS.has(w));
  if (shortAnswer) {
    if (input.lumiAsked) return { verdict: "yes", reason: "answer to Lumi's question" };
    // "grazie" after an answer closes the exchange: Lumi can reply with a word
    if (opened === "followup" && !input.inCall && ws.some((w) => w === "grazie" || w === "ciao")) return { verdict: "yes", reason: "thanks" };
    return { verdict: "no", reason: "filler" };
  }

  const rest = afterGreetings(ws);
  const names = new Set((input.names ?? []).flatMap((n) => words(n).slice(0, 1)));
  if (OTHERS.has(rest[0]) || names.has(rest[0])) return { verdict: "no", reason: "calls someone else" };

  if (input.lumiAsked) return { verdict: "yes", reason: "answer to Lumi's question" };
  // Another voice speaking: they talk among themselves unless they call Lumi (the name, answered above)
  if (input.otherVoice) return { verdict: "no", reason: "another voice" };
  if (input.inCall) return { verdict: opened === "followup" ? "maybe" : "no", reason: "in a call with friends" };

  const text = ws.join(" ");
  const thread = threadIsOpen(input.threadAgo);
  // Two voices answering each other: only a clear request could be for Lumi, and then the model reads the exchange
  if (input.othersHeard === true) {
    if (REQUEST.test(text) || thread) return { verdict: "maybe", reason: "others are talking nearby" };
    return { verdict: "no", reason: "others are talking nearby" };
  }
  if (REQUEST.test(text)) return { verdict: "yes", reason: "request" };
  // Nobody else answers: a sentence that takes up the exchange with Lumi is for Lumi
  if (thread && CONTINUATION.test(text)) return { verdict: "yes", reason: "continues the exchange" };
  if (ws.length >= LONG_WORDS) return { verdict: "maybe", reason: "long talk" };
  return { verdict: "maybe", reason: thread ? "during an exchange" : "unclear" };
}

function threadIsOpen(threadAgo: number | null | undefined): boolean {
  return threadAgo !== null && threadAgo !== undefined && threadAgo <= THREAD_SECONDS;
}

/**
 * What to do with a "maybe" when the model can't answer: the window right after an answer, and
 * an exchange still open with nobody else talking, count as being for Lumi; anything else doesn't.
 */
export function addressedWithoutModel(input: AddressingInput): boolean {
  if (input.otherVoice || input.inCall || input.othersHeard === true) return false;
  return input.opened === "followup" || threadIsOpen(input.threadAgo);
}

// ---------------- the model's judgment ----------------

export const ADDRESSING_SYSTEM = `You are the ears of Lumi, a voice assistant that lives on the user's computer screen. The microphone just picked up one sentence, in Italian. Decide whether the user said it TO Lumi (a request, a question, a reply to what Lumi just said, a greeting or a remark meant for Lumi) or NOT to Lumi.
Not to Lumi: talking to another person in the room, on the phone or in a call; talking to themselves or thinking aloud; reading aloud; commenting a game, a video or music; singing; a voice coming from a speaker.
Clues: Lumi's last line and whether it asked something; a reply right after Lumi spoke is usually for Lumi; a sentence that continues or refers back to the topic of the recent exchange with Lumi ("e domani?", "quello che hai detto", "perché?") is for Lumi even after a pause, as long as no other voice is joining in; if another voice has been answering the user nearby, they are talking to each other; a question about Lumi itself, its screen or what it does ("mi senti?", "cosa stai guardando?") is for Lumi; a statement about something else ("ho fame", "che caldo", "no, quello a sinistra") is usually not, unless it answers Lumi.
When unsure, answer false. Reply with only JSON: {"to_lumi": true} or {"to_lumi": false}`;

export interface AddressingPromptInput {
  text: string;
  /** The last few conversation lines, oldest first ("Tu: ...", "Lumi: ..."). */
  conversation: string[];
  /** Seconds since Lumi last spoke (null: not recently). */
  lumiAgo: number | null;
  inCall: boolean;
  /** Another voice was heard nearby in the last half minute (null: voices aren't recognized, unknown). */
  othersHeard?: boolean | null;
  /** How the turn opened: "followup" is within seconds of an answer. */
  opened: Opened;
}

export function addressingPrompt(input: AddressingPromptInput): string {
  const lines = [
    input.conversation.length ? `Recent conversation:\n${input.conversation.join("\n")}` : "Recent conversation: (none)",
    input.lumiAgo !== null ? `Lumi spoke ${Math.round(input.lumiAgo)} seconds ago.` : "Lumi has not spoken recently.",
    input.inCall ? "The user is in a call with friends right now." : "The user is not in a call.",
    input.othersHeard === true
      ? "Another voice (not the user's) was heard nearby in the last 30 seconds: someone may be talking with the user."
      : input.othersHeard === false
        ? "Only the user's voice was heard in the last 30 seconds: nobody seems to answer them."
        : "Other voices nearby: unknown.",
    `Sentence heard: "${input.text.replace(/"/g, "'")}"`,
  ];
  return lines.join("\n");
}

/** The model's answer: true or false, null when it can't be read. */
export function parseAddressingReply(text: string): boolean | null {
  const json = /\{[\s\S]*?\}/.exec(text)?.[0];
  if (json) {
    try {
      const o = JSON.parse(json) as { to_lumi?: unknown };
      if (typeof o.to_lumi === "boolean") return o.to_lumi;
    } catch {
      // not JSON: read the words below
    }
  }
  // Not JSON: a plain "true" / "yes" or "false" / "no" (both or neither: no answer)
  const t = text.toLowerCase();
  const yes = /\b(true|yes)\b/.test(t);
  const no = /\b(false|no)\b/.test(t);
  return yes === no ? null : yes;
}
