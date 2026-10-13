// End of turn: silence alone is not enough, because people pause in the
// middle of a sentence. The VAD silence (500 ms) is combined with a
// semantic check: Smart Turn's probability that the turn is complete, or
// a heuristic on the last word ("e", "ma", "quindi" -> wait). When the turn
// looks unfinished the wait grows up to 1.2 s. Pure, tested.

export const MIN_SILENCE_MS = 500;
export const MAX_SILENCE_MS = 1200;

/** Words after which an Italian sentence is clearly not finished. */
const CONTINUES = new Set([
  "e", "ed", "ma", "però", "quindi", "perché", "perchè", "che", "cioè", "allora", "oppure", "o", "od", "se", "quando", "mentre",
  "come", "dove", "anche", "poi", "infatti", "comunque", "tipo", "praticamente", "insomma", "dunque", "invece", "siccome",
  "di", "a", "da", "in", "con", "su", "per", "tra", "fra", "il", "lo", "la", "i", "gli", "le", "l", "un", "uno", "una",
  "del", "dello", "della", "dei", "degli", "delle", "al", "allo", "alla", "ai", "agli", "alle", "dal", "dalla", "nel", "nello",
  "nella", "nei", "sul", "sulla", "col", "mio", "mia", "tuo", "tua", "suo", "sua", "questo", "questa", "quel", "quella",
  "ehm", "ehh", "uhm", "mmh", "eh", "qual", "quale", "vorrei", "volevo", "potresti", "dovrei", "and", "but", "so", "the", "to", "of",
]);

/** The transcript so far sounds like the user is going to continue. */
export function trailingIncomplete(text: string | null): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  // A trailing comma, colon or ellipsis is a pause, not an end
  if (/(,|:|;|\.\.\.|…|-)$/.test(trimmed)) return true;
  if (/[.!?]$/.test(trimmed) && !/\.\.\.$/.test(trimmed)) return false;
  const last = trimmed
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]/gu, " ")
    .split(/[\s']+/)
    .filter(Boolean)
    .pop();
  return last !== undefined && CONTINUES.has(last);
}

/** The transcript ends like a finished sentence: . ! ? (not an ellipsis). */
export function endsSentence(text: string | null): boolean {
  const t = text?.trim() ?? "";
  return /[.!?]["»)]*$/.test(t) && !/(\.\.\.|…)$/.test(t);
}

/**
 * How much silence ends the turn. `turnComplete` is Smart Turn's
 * probability (null when unavailable); the heuristic covers the rest.
 */
export function requiredSilenceMs(transcript: string | null, turnComplete: number | null): number {
  if (turnComplete !== null && Number.isFinite(turnComplete)) {
    // An unfinished last word overrides an optimistic model; a sentence that
    // ends with final punctuation (Whisper hears the intonation) tempers a
    // pessimistic one
    const p = trailingIncomplete(transcript) ? Math.min(turnComplete, 0.3) : endsSentence(transcript) ? Math.max(turnComplete, 0.5) : turnComplete;
    if (p >= 0.7) return MIN_SILENCE_MS;
    if (p <= 0.3) return MAX_SILENCE_MS;
    return Math.round(MAX_SILENCE_MS - ((p - 0.3) / 0.4) * (MAX_SILENCE_MS - MIN_SILENCE_MS));
  }
  return trailingIncomplete(transcript) ? MAX_SILENCE_MS : MIN_SILENCE_MS;
}

/** Whether `silenceMs` of silence ends the turn. */
export function turnEnded(silenceMs: number, transcript: string | null, turnComplete: number | null): boolean {
  return silenceMs >= requiredSilenceMs(transcript, turnComplete);
}

/** Utterances that are only noise, a cough or a backchannel of the user's own. */
export function meaningless(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return true;
  return words.every((w) => /^(m+h*|e+h*|a+h*|u+h*m*|o+h*|h+m+|ok)$/.test(w)) && words.length <= 2;
}
