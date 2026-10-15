// Emotions the model can give to what it says. Each one drives both the
// voice (the sidecar maps it to an engine-specific style, see
// sidecar/tts/emotions.json) and the shape of the eyes.

export const EMOTIONS = [
  "neutra",
  "gioia",
  "tristezza",
  "sorpresa",
  "rabbia",
  "pensiero",
  "imbarazzo",
  "sonno",
  // Precise, a little pedantic ("Uhm, in realtà..."): flat eyes reading, glasses pushed up
  "saccente",
  // Doubt: slit eyes with lines above and below, a fixed sideways look
  "sospetto",
  // Fear: tiny pupils in big rings, a steady tremble
  "paura",
  // Anime-style shock: empty rings, violet lines, a freeze and a jolt
  "spavento",
  // > < : straining, or wincing at a bad pun
  "smorfia",
  // _ _ : flat lines, bored, deadpan
  "apatia",
] as const;
export type Emotion = (typeof EMOTIONS)[number];

/** Face expressions: the emotions plus states that only the face shows. */
export const EXPRESSIONS = [...EMOTIONS, "ascolto"] as const;
export type Expression = (typeof EXPRESSIONS)[number];

export function isEmotion(value: unknown): value is Emotion {
  return typeof value === "string" && (EMOTIONS as readonly string[]).includes(value);
}

/** English and Italian synonyms small models tend to use instead of the listed ids. */
const SYNONYMS: Record<string, Emotion> = {
  neutral: "neutra",
  neutro: "neutra",
  calm: "neutra",
  calma: "neutra",
  happy: "gioia",
  joy: "gioia",
  felice: "gioia",
  allegria: "gioia",
  excited: "gioia",
  entusiasmo: "gioia",
  sad: "tristezza",
  triste: "tristezza",
  surprised: "sorpresa",
  surprise: "sorpresa",
  stupore: "sorpresa",
  angry: "rabbia",
  anger: "rabbia",
  fastidio: "rabbia",
  annoyed: "rabbia",
  thinking: "pensiero",
  pensieroso: "pensiero",
  curious: "pensiero",
  curiosità: "pensiero",
  embarrassed: "imbarazzo",
  imbarazzato: "imbarazzo",
  sleepy: "sonno",
  assonnato: "sonno",
  tired: "sonno",
  nerd: "saccente",
  pedante: "saccente",
  precisino: "saccente",
  pedantic: "saccente",
  smug: "saccente",
  suspicious: "sospetto",
  sospettoso: "sospetto",
  dubbio: "sospetto",
  doubt: "sospetto",
  skeptical: "sospetto",
  scettico: "sospetto",
  fear: "paura",
  afraid: "paura",
  scared: "paura",
  timore: "paura",
  spaventato: "spavento",
  shock: "spavento",
  shocked: "spavento",
  terrore: "spavento",
  panico: "spavento",
  cringe: "smorfia",
  strain: "smorfia",
  sforzo: "smorfia",
  wince: "smorfia",
  bored: "apatia",
  annoiato: "apatia",
  noia: "apatia",
  apathetic: "apatia",
  apatico: "apatia",
  sarcasmo: "apatia",
  sarcastic: "apatia",
  deadpan: "apatia",
};

/** The emotion named by `value`, accepting common synonyms; null when unknown. */
export function toEmotion(value: unknown): Emotion | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  if (isEmotion(key)) return key;
  return SYNONYMS[key] ?? null;
}

/** Words or phrases (lowercase), matched whole: "grande" but not "grandezza". */
function words(...list: string[]): RegExp {
  return new RegExp(String.raw`(?<!\p{L})(?:${list.join("|")})(?!\p{L})`, "u");
}

/** Cues for guessEmotion, checked in this order (the first match wins). */
const CUES: { emotion: Emotion; intensity: number; re: RegExp }[] = [
  { emotion: "spavento", intensity: 0.7, re: words("aiuto", "oh no", "oddio") },
  { emotion: "paura", intensity: 0.5, re: words("che paura", "attenzione", "pericolos[oa]", "rischios[oa]", "attent[oa]", "irreversibile") },
  { emotion: "tristezza", intensity: 0.5, re: words("mi dispiace", "purtroppo", "peccato", "che triste", "condoglianze", "che brutto") },
  { emotion: "saccente", intensity: 0.5, re: words("in realtà", "tecnicamente", "per la precisione", "a essere precisi", "a voler essere precisi") },
  { emotion: "sospetto", intensity: 0.5, re: words("sospetto", "mi puzza", "sicuro sicuro", "strano", "non mi convince", "davvero davvero") },
  { emotion: "smorfia", intensity: 0.5, re: words("ahia", "che battuta", "che freddura", "pessima", "ugh") },
  { emotion: "apatia", intensity: 0.5, re: words("che noia", "bah", "wow\\.\\.\\.", "ma dai\\.\\.\\.", "come no", "certo certo") },
  { emotion: "rabbia", intensity: 0.4, re: words("uffa", "che rabbia", "che fastidio", "insopportabile", "che nervi") },
  { emotion: "imbarazzo", intensity: 0.4, re: words("oops", "ops", "scusa", "scusami", "che imbarazzo", "ehm") },
  { emotion: "sorpresa", intensity: 0.5, re: words("wow", "incredibile", "non ci credo", "accidenti", "caspita", String.raw`davvero\?`) },
  { emotion: "gioia", intensity: 0.6, re: words("evviva", "evvai", "fantastico", "che bello", "bellissim[oa]", "ottimo", "perfetto", "(?:ah){2,}", "(?:ha){2,}") },
  { emotion: "pensiero", intensity: 0.4, re: words("hm+", "mh+", "vediamo", "chissà", "non saprei", "forse") },
];

/**
 * A light guess of the emotion of a sentence, from its punctuation and a
 * few cue words, for when the model didn't give one. An explicit emotion
 * always wins over this.
 */
export function guessEmotion(text: string): { emotion: Emotion; intensity: number } {
  const t = text.toLowerCase();
  for (const cue of CUES) if (cue.re.test(t)) return { emotion: cue.emotion, intensity: cue.intensity };
  // "?!" or "!?": astonishment
  if (/\?\s*!|!\s*\?/.test(t)) return { emotion: "sorpresa", intensity: 0.5 };
  if (t.includes("!")) return { emotion: "gioia", intensity: 0.35 };
  return { emotion: "neutra", intensity: 0.6 };
}

/** Keeps intensities in 0..1; a missing one is a moderate 0.6. */
export function clampIntensity(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.6;
}
