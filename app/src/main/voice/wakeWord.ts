// Wake word spotting on transcripts: "Ehi Lumi, che ore sono?" -> the rest
// of the sentence is the request. Speech recognition writes the name in
// many ways ("Lumi", "Lumì", "Lume", "Rumi", "Hey Lumi"), so the match is
// fuzzy. Works for any custom word without training a model. Pure, tested.

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Edit distance between two short strings. */
export function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = temp;
    }
  }
  return prev[b.length];
}

const GREETINGS = new Set(["ehi", "hey", "ei", "ehy", "ehilà", "hei", "e", "eh", "ok", "okay", "oh", "ciao", "senti", "scusa"]);

export interface WakeMatch {
  matched: boolean;
  /** What follows the wake word (the request), possibly empty. */
  rest: string;
}

/**
 * Looks for the wake word ("ehi lumi") at the start of a transcript, or
 * its name part alone within the first few words.
 */
export function matchWakeWord(transcript: string, wakeWord: string): WakeMatch {
  const words = transcript.trim().split(/\s+/).filter(Boolean);
  const target = normalize(wakeWord).split(" ").filter(Boolean);
  if (!words.length || !target.length) return { matched: false, rest: "" };
  // The distinctive part is the last word ("lumi"); greetings before it are optional
  const name = target[target.length - 1];
  const tolerance = name.length <= 4 ? 1 : 2;
  for (let i = 0; i < Math.min(words.length, 4); i++) {
    const word = normalize(words[i]);
    if (!word) continue;
    if (distance(word, name) <= tolerance) {
      const before = words.slice(0, i).map(normalize);
      // Only greetings may come before the name ("ehi", "ok", "ciao")
      if (before.every((w) => GREETINGS.has(w) || target.includes(w))) {
        const rest = words
          .slice(i + 1)
          .join(" ")
          .replace(/^[\s,.:;!?-]+/, "");
        return { matched: true, rest };
      }
    }
  }
  return { matched: false, rest: "" };
}
