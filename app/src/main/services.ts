// The AI services as configured: providers are cached so what they learn
// about each model (no tools, no images) sticks, and rebuilt when keys or
// addresses change. Also the connection test of the settings window.
import { net } from "electron";
import { PROVIDERS, type ProviderId } from "../shared/providers";
import type { BrainChoice, ConnectionReport, Settings } from "../shared/types";
import type { Purpose } from "./brain/brain";
import { createProvider, listModels, ProviderError, type ChatProvider, type FetchLike } from "./brain/providers";
import { log } from "./log";
import type { ApiKeyStore } from "./secrets";

export class Services {
  private readonly cache = new Map<string, ChatProvider>();
  // Electron's network stack (Chromium) trusts the Windows certificate store
  // and follows the system proxy: Node's fetch fails behind networks that
  // inspect HTTPS with their own certificate authority.
  readonly fetch: FetchLike = (input, init) => net.fetch(input instanceof URL ? input.href : input, init);

  constructor(
    private readonly settings: () => Settings,
    private readonly keys: ApiKeyStore,
  ) {}

  config(id: ProviderId) {
    const s = this.settings();
    return { apiKey: this.keys.get(id), ollamaUrl: s.brain.ollamaUrl, customUrl: s.brain.customUrl, fetch: this.fetch };
  }

  provider(id: ProviderId): ChatProvider | null {
    const config = this.config(id);
    const cacheKey = `${id}|${config.apiKey ?? ""}|${config.ollamaUrl}|${config.customUrl}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const created = createProvider(id, config);
    if (created) this.cache.set(cacheKey, created);
    return created;
  }

  /** The service and model for conversations, autonomous moments or vision. */
  chosen(purpose: Purpose | "vision"): { provider: ChatProvider; model: string } | null {
    const brain = this.settings().brain;
    let choice: BrainChoice = purpose === "chat" ? brain.chat : purpose === "idle" ? brain.idle : brain.vision;
    // Vision with no model of its own uses the conversation model
    if (purpose === "vision" && !choice.model) choice = brain.chat;
    const provider = choice.model ? this.provider(choice.provider) : null;
    return provider ? { provider, model: choice.model } : null;
  }

  /** A separate vision model is configured (look_at_screen describes the screenshot with it). */
  separateVision(): boolean {
    const brain = this.settings().brain;
    return !!brain.vision.model && (brain.vision.model !== brain.chat.model || brain.vision.provider !== brain.chat.provider);
  }

  invalidate(): void {
    this.cache.clear();
  }

  async listModels(id: ProviderId): Promise<{ ok: boolean; models: string[]; message: string }> {
    try {
      const models = await listModels(id, this.config(id));
      return { ok: true, models, message: models.length ? `${models.length} modelli trovati.` : "Nessun modello trovato." };
    } catch (err) {
      const offline = err instanceof ProviderError && err.kind === "connection" && id === "ollama";
      const message = offline ? "Ollama non risponde: è installato e avviato?" : err instanceof Error ? err.message : String(err);
      return { ok: false, models: [], message };
    }
  }

  /** Tries the services chosen for conversation, autonomous moments and vision. */
  async test(): Promise<ConnectionReport[]> {
    const reports: ConnectionReport[] = [];
    const tried = new Set<string>();
    const brain = this.settings().brain;
    for (const [purpose, label, choice] of [
      ["chat", "Conversazione", brain.chat],
      ["idle", "Commenti spontanei", brain.idle],
      ["vision", "Visione", brain.vision.model ? brain.vision : null],
    ] as const) {
      if (!choice) continue;
      const what = `${label}: ${PROVIDERS[choice.provider].name}${choice.model ? `, ${choice.model}` : ""}`;
      if (tried.has(`${choice.provider}|${choice.model}`)) continue;
      tried.add(`${choice.provider}|${choice.model}`);
      const chosen = this.chosen(purpose);
      if (!chosen) {
        const missing = !choice.model ? "scegli un modello" : choice.provider === "custom" && !brain.customUrl ? "manca l'indirizzo del servizio" : "manca la chiave API";
        reports.push({ ok: false, message: `${what}: ${missing}.` });
        continue;
      }
      const started = Date.now();
      try {
        const result = await chosen.provider.complete({ model: chosen.model, system: "Reply with a single short, friendly Italian word.", prompt: "Ciao!", maxTokens: 64 });
        const ms = Date.now() - started;
        reports.push({ ok: true, message: `${what}: funziona in ${(ms / 1000).toFixed(1)} s${result.text ? ` (ha risposto "${result.text.slice(0, 40)}")` : ""}.` });
      } catch (err) {
        log.warn("Connection test failed", err);
        const e = err instanceof ProviderError ? err : new ProviderError("unknown", String(err));
        const hint: Record<string, string> = {
          auth: "la chiave API non è valida",
          permission: "la chiave non può usare questo modello",
          not_found: choice.provider === "ollama" ? `modello non trovato: scaricalo con "ollama pull ${choice.model}"` : "modello non trovato",
          rate_limit: "limite di richieste raggiunto, riprova tra poco",
          connection:
            choice.provider === "ollama"
              ? "Ollama non risponde: è installato e avviato?"
              : e.certificate
                ? `certificato della connessione non valido (${e.message})`
                : `non riesco a raggiungere il servizio (${e.message})`,
          overloaded: "il servizio è sovraccarico o non risponde, riprova tra poco",
        };
        reports.push({ ok: false, message: `${what}: ${hint[e.kind] ?? e.message}.` });
      }
    }
    return reports;
  }
}
