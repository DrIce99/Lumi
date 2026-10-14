// Hardware profiles: which brain, speech recognition and voice fit a PC.
// The first-run wizard detects the GPU and proposes one.
import type { GpuInfo, Profile, Settings } from "./types";

export interface ProfileInfo {
  label: string;
  description: string;
  /** Rough VRAM need (GB) shown to the user. */
  vram: string;
}

export const PROFILE_INFO: Record<Profile, ProfileInfo> = {
  leggero: {
    label: "Leggero",
    description: "Nessuna scheda video: cervello Groq o Gemini, riconoscimento vocale Whisper di Groq, voce Kokoro sul processore.",
    vram: "0 GB",
  },
  bilanciato: {
    label: "Bilanciato",
    description: "Scheda video da 6-8 GB: cervello Groq o Gemini, faster-whisper turbo e Qwen3-TTS 1.7B sul tuo PC.",
    vram: "circa 6 GB",
  },
  locale: {
    label: "Tutto locale",
    description: "Scheda video da 16 GB o più: anche il cervello gira sul PC con Ollama (qwen3 8B). Non esce nulla.",
    vram: "circa 12-14 GB",
  },
};

/** The profile that fits the detected GPU. */
export function suggestProfile(gpu: GpuInfo | null): Profile {
  if (!gpu || gpu.vramTotalMb < 5500) return "leggero";
  if (gpu.vramTotalMb < 15000) return "bilanciato";
  return "locale";
}

/** Settings changed by a profile; everything else is kept. */
export function applyProfile(settings: Settings, profile: Profile): Settings {
  const s = structuredClone(settings);
  s.profile = profile;
  switch (profile) {
    case "leggero":
      s.brain.chat = { provider: "groq", model: "openai/gpt-oss-120b" };
      s.brain.idle = { provider: "groq", model: "openai/gpt-oss-20b" };
      s.brain.vision = { provider: "gemini", model: "" };
      // No GPU: no local vision, the OCR text only (unless screenshots are allowed online)
      s.vision = { ...s.vision, provider: "none" };
      s.stt = { ...s.stt, engine: "groq", model: "whisper-large-v3-turbo", device: "cpu" };
      s.tts = { ...s.tts, engine: "kokoro", model: "v1.0", voice: "im_nicola" };
      break;
    case "bilanciato":
      s.brain.chat = { provider: "groq", model: "openai/gpt-oss-120b" };
      s.brain.idle = { provider: "ollama", model: "qwen3" };
      s.brain.vision = { provider: "gemini", model: "" };
      s.vision = { ...s.vision, provider: "ollama", model: "qwen3-vl:8b" };
      s.stt = { ...s.stt, engine: "faster-whisper", model: "large-v3-turbo", device: "auto" };
      s.tts = { ...s.tts, engine: "qwen3", model: "1.7B-CustomVoice", voice: "ryan" };
      break;
    case "locale":
      s.brain.chat = { provider: "ollama", model: "qwen3" };
      s.brain.idle = { provider: "ollama", model: "qwen3" };
      s.brain.vision = { provider: "ollama", model: "qwen2.5vl" };
      s.vision = { ...s.vision, provider: "ollama", model: "qwen3-vl:8b" };
      s.stt = { ...s.stt, engine: "faster-whisper", model: "large-v3-turbo", device: "auto" };
      s.tts = { ...s.tts, engine: "qwen3", model: "1.7B-CustomVoice", voice: "ryan" };
      break;
  }
  return s;
}
