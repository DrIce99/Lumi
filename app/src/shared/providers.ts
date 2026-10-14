// AI services Lumi can think with. Ollama uses its native API; everything
// else speaks the OpenAI-compatible chat API. Only free (or local) services:
// there is deliberately no paid provider.

export const PROVIDER_IDS = ["ollama", "ollama-cloud", "groq", "gemini", "openrouter", "custom"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderInfo {
  label: string;
  /** Short name used inside sentences ("la chiave di …"). */
  name: string;
  /** API family. */
  kind: "ollama" | "openai";
  needsKey: boolean;
  /** OpenAI-compatible base URL for hosted services. */
  baseUrl?: string;
  envKey?: string;
  keyHelp?: string;
  note: string;
  /** Example models; "Rileva modelli" fetches the real list. */
  suggestions: string[];
  /** Models suggested for look_at_screen (they accept images). */
  visionSuggestions: string[];
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  ollama: {
    label: "Ollama (sul tuo PC, gratis)",
    name: "Ollama",
    kind: "ollama",
    needsKey: false,
    note: "Gratis e privato: il modello gira sul tuo computer. Installa Ollama da ollama.com, poi scarica un modello, per esempio \"ollama pull gemma4:e4b\" (piccolo, veloce e vede le immagini) o \"ollama pull qwen3\" (per vedere lo schermo anche \"qwen2.5vl\" o \"mistral-small3.2\"). La voce e il modello si dividono la memoria della scheda video. Se Ollama è chiuso, Lumi lo avvia.",
    suggestions: ["gemma4:e4b", "qwen3", "gemma4:e2b", "qwen3:4b", "qwen2.5vl", "mistral-small3.2"],
    visionSuggestions: ["gemma4:e4b", "qwen2.5vl", "mistral-small3.2", "gemma3"],
  },
  "ollama-cloud": {
    label: "Ollama Cloud (online)",
    name: "Ollama Cloud",
    kind: "ollama",
    needsKey: true,
    baseUrl: "https://ollama.com",
    envKey: "OLLAMA_API_KEY",
    keyHelp: "ollama.com/settings/keys",
    note: "I modelli vengono eseguiti sui server Ollama: crea una API key su ollama.com/settings/keys, inseriscila qui e premi «Rileva modelli». Le richieste e i dati inviati vengono elaborati online da Ollama.",
    suggestions: ["gemma4:31b"],
    visionSuggestions: [],
  },
  groq: {
    label: "Groq (gratis con limiti)",
    name: "Groq",
    kind: "openai",
    needsKey: true,
    baseUrl: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
    keyHelp: "console.groq.com → API Keys",
    note: "Gratis con limiti e con la latenza più bassa: il più adatto alla conversazione a voce. Con la stessa chiave Lumi può usare anche Whisper di Groq per capire cosa dici (l'audio esce dal PC).",
    // qwen3.8-27b sees images but describes tool calls in words instead of making them: vision only
    suggestions: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"],
    visionSuggestions: ["qwen/qwen3.8-27b"],
  },
  gemini: {
    label: "Google Gemini (gratis con limiti)",
    name: "Gemini",
    kind: "openai",
    needsKey: true,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKey: "GEMINI_API_KEY",
    keyHelp: "aistudio.google.com → Get API key",
    note: "Piano gratuito con limiti giornalieri, vede le immagini. Attenzione: sul piano gratuito Google può usare i contenuti inviati (anche gli screenshot) per migliorare i suoi servizi.",
    suggestions: ["gemini-flash-lite-latest", "gemini-flash-latest"],
    visionSuggestions: ["gemini-flash-lite-latest", "gemini-flash-latest"],
  },
  openrouter: {
    label: "OpenRouter (modelli :free)",
    name: "OpenRouter",
    kind: "openai",
    needsKey: true,
    baseUrl: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    keyHelp: "openrouter.ai → Keys",
    note: "Un'unica chiave per tanti modelli: quelli che finiscono con \":free\" sono gratuiti (con limiti). La latenza varia molto da un modello all'altro. Usa \"Rileva modelli\" per vederli.",
    suggestions: [],
    visionSuggestions: [],
  },
  custom: {
    label: "Altro servizio compatibile OpenAI",
    name: "questo servizio",
    kind: "openai",
    needsKey: false,
    note: "LM Studio, llama.cpp server e altri: indica l'indirizzo base dell'API (di solito finisce con /v1) e, se serve, la chiave.",
    suggestions: [],
    visionSuggestions: [],
  },
};

/** Models a service retired, with what replaces them (saved settings are updated on load). */
export const RETIRED_MODELS: Partial<Record<ProviderId, Record<string, string>>> = {
  groq: {
    "llama-3.3-70b-versatile": "openai/gpt-oss-120b",
    "llama-3.1-8b-instant": "openai/gpt-oss-20b",
    "qwen/qwen3-32b": "openai/gpt-oss-120b",
    "meta-llama/llama-4-scout-17b-16e-instruct": "qwen/qwen3.8-27b",
    "meta-llama/llama-4-maverick-17b-128e-instruct": "qwen/qwen3.8-27b",
  },
};

export function isProvider(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

export const DEFAULT_OLLAMA_URL = "http://localhost:11434";
