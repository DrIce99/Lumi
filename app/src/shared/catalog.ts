// Models and voices offered for each speech engine. The sidecar reports
// what is actually installed; these are the choices shown in the settings.
import type { SttEngine, TtsEngine } from "./types";

export interface Choice {
  id: string;
  label: string;
}

export const TTS_MODELS: Record<TtsEngine, Choice[]> = {
  qwen3: [
    { id: "1.7B-Base", label: "1.7B, voce clonata: italiana inclusa o da un campione (consigliato)" },
    { id: "0.6B-Base", label: "0.6B, voce clonata (poca memoria video)" },
    { id: "1.7B-CustomVoice", label: "1.7B, voci predefinite con emozioni (accento straniero)" },
    { id: "0.6B-CustomVoice", label: "0.6B, voci predefinite (accento straniero)" },
    { id: "1.7B-VoiceDesign", label: "1.7B, voce descritta a parole (cambia tra le frasi)" },
    { id: "1.7B-Italiano", label: "1.7B addestrato in italiano (LoRA: va creato, vedi sidecar/lora)" },
  ],
  chatterbox: [{ id: "multilingual", label: "Multilingual (clonazione da un campione)" }],
  kokoro: [{ id: "v1.0", label: "v1.0 (leggero, anche sul processore)" }],
};

/** Predefined voices; cloning models take the path of a reference clip instead. */
export const TTS_VOICES: Record<TtsEngine, string[]> = {
  qwen3: ["ryan", "aiden", "eric", "dylan", "uncle_fu", "vivian", "serena", "sohee", "ono_anna"],
  chatterbox: ["predefinita"],
  kokoro: ["im_nicola", "if_sara"],
};

/** Italian reference clips shipped with the sidecar (sidecar/tts/voices): an empty clip field means "italiana". */
export const BUNDLED_VOICES = ["italiana", "italiano"];

/** What the voice field means for a TTS model. */
export function voiceKind(engine: TtsEngine, model: string): "speaker" | "description" | "clip" | "trained" {
  if (engine === "qwen3" && /Italiano/i.test(model)) return "trained";
  if (engine === "qwen3" && /VoiceDesign/i.test(model)) return "description";
  if (engine === "qwen3" && /Base/i.test(model)) return "clip";
  if (engine === "chatterbox") return "clip";
  return "speaker";
}

/** The voice to start from when the engine changes. */
export function defaultVoice(engine: TtsEngine, model: string): string {
  if (engine === "qwen3" && ["clip", "trained"].includes(voiceKind(engine, model))) return "";
  if (voiceKind(engine, model) === "description") return DEFAULT_VOICE_DESCRIPTION;
  return TTS_VOICES[engine][0];
}

export const DEFAULT_VOICE_DESCRIPTION = "Voce maschile giovane, calda e vivace, italiano naturale con dizione chiara";

export const STT_MODELS: Record<SttEngine, string[]> = {
  "faster-whisper": ["large-v3-turbo", "large-v3", "medium", "small", "base"],
  parakeet: ["nemo-parakeet-tdt-0.6b-v3"],
  "whisper-cpp": ["large-v3-turbo-q5_0", "medium-q5_0", "small", "base"],
  groq: ["whisper-large-v3-turbo", "whisper-large-v3"],
};
