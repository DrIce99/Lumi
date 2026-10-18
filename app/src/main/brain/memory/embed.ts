// Embeddings for the memory, from Ollama (/api/embed; bge-m3 by default:
// multilingual, good in Italian) or, without Ollama, from the sidecar on the
// CPU (POST /embed: bge-m3 int8 in ONNX, roadmap 10.6). Runs in the memory
// worker: plain fetch, both servers are local. Errors say whether the model
// is missing (worth a hint: "ollama pull ...") or the server is down.
import { embeddingInput } from "./search";

export interface Embedder {
  readonly model: string;
  readonly source: "ollama" | "sidecar";
  /** One vector per text, same order. */
  embed(texts: string[], kind: "query" | "document", timeoutMs: number): Promise<number[][]>;
}

export class EmbedError extends Error {
  constructor(
    message: string,
    readonly kind: "offline" | "missing" | "failed",
  ) {
    super(message);
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class OllamaEmbedder implements Embedder {
  readonly source = "ollama";

  constructor(
    private readonly url: string,
    readonly model: string,
    /** How long Ollama keeps the model loaded after a request (VRAM is shared with the voice). */
    private readonly keepAlive = "10m",
    private readonly fetch: FetchLike = globalThis.fetch,
  ) {}

  async embed(texts: string[], kind: "query" | "document", timeoutMs: number): Promise<number[][]> {
    if (!texts.length) return [];
    let res: Response;
    try {
      res = await this.fetch(`${this.url.replace(/\/+$/, "")}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: texts.map((t) => embeddingInput(this.model, kind, t)), keep_alive: this.keepAlive, truncate: true }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new EmbedError(timeout ? `no answer in ${timeoutMs} ms` : `Ollama doesn't answer (${err instanceof Error ? err.message : String(err)})`, timeout ? "failed" : "offline");
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new EmbedError(`Ollama ${res.status}: ${detail}`, res.status === 404 || /not found|pull/i.test(detail) ? "missing" : "failed");
    }
    const data = (await res.json()) as { embeddings?: number[][] };
    const vectors = data.embeddings ?? [];
    if (vectors.length !== texts.length || vectors.some((v) => !Array.isArray(v) || !v.length)) throw new EmbedError("Ollama returned no embeddings", "failed");
    return vectors;
  }
}

/** The sidecar's model: bge-m3 too, so the similarity floor measured for it holds (cosine >= 0.985 with Ollama's). */
export const SIDECAR_EMBED_MODEL = "bge-m3-int8";

export class SidecarEmbedder implements Embedder {
  readonly source = "sidecar";

  constructor(
    /** null while the sidecar is down: every call is "offline" until it is back. */
    private readonly url: string | null,
    private readonly token: string,
    readonly model = SIDECAR_EMBED_MODEL,
    private readonly fetch: FetchLike = globalThis.fetch,
  ) {}

  async embed(texts: string[], kind: "query" | "document", timeoutMs: number): Promise<number[][]> {
    if (!texts.length) return [];
    if (!this.url) throw new EmbedError("the sidecar is not running", "offline");
    let res: Response;
    try {
      res = await this.fetch(`${this.url.replace(/\/+$/, "")}/embed`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ texts: texts.map((t) => embeddingInput(this.model, kind, t)), kind, model: this.model }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new EmbedError(timeout ? `no answer in ${timeoutMs} ms` : `the sidecar doesn't answer (${err instanceof Error ? err.message : String(err)})`, timeout ? "failed" : "offline");
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new EmbedError(`sidecar ${res.status}: ${detail}`, res.status === 401 ? "offline" : "failed");
    }
    const data = (await res.json()) as { vectors?: number[][] };
    const vectors = data.vectors ?? [];
    if (vectors.length !== texts.length || vectors.some((v) => !Array.isArray(v) || !v.length)) throw new EmbedError("the sidecar returned no embeddings", "failed");
    return vectors;
  }
}
