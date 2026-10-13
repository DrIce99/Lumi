// Emotions the model can give to what it says. Each one drives both the
// voice (the sidecar maps it to an engine-specific style, see
// sidecar/tts/emotions.json) and the shape of the eyes.

export const EMOTIONS = ["neutra", "gioia", "tristezza", "sorpresa", "rabbia", "pensiero", "imbarazzo", "sonno"] as const;
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
};

/** The emotion named by `value`, accepting common synonyms; null when unknown. */
export function toEmotion(value: unknown): Emotion | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  if (isEmotion(key)) return key;
  return SYNONYMS[key] ?? null;
}

/** Keeps intensities in 0..1; a missing one is a moderate 0.6. */
export function clampIntensity(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.6;
}
