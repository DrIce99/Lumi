// The embedding queue: in the memory worker, a background loop gives a
// vector to every line and summary that has none for the current model,
// newest first, in small batches. The "queue" is a query (what has no
// vector yet), so a new line, an import or a change of model all go
// through the same loop: on a model change the old vectors stay searchable
// only as words until the new model covers everything, then they go.
// It waits while Lumi is busy (answering, speaking): the GPU is shared with
// the voice. Never blocks a conversation turn.
import type { MemoryDb } from "./db";
import { EmbedError, type Embedder } from "./embed";

export interface IndexStatus {
  /** off: no embeddings configured; unavailable: sqlite-vec didn't load. */
  state: "off" | "unavailable" | "idle" | "indexing" | "waiting" | "missing" | "offline" | "error";
  model: string;
  done: number;
  total: number;
  detail?: string;
}

export const BATCH = 16;
/** After Lumi is busy, wait this long before indexing again. */
const QUIET_MS = 5000;
const NEXT_BATCH_MS = 150;
const IDLE_MS = 20_000;
const OFFLINE_RETRY_MS = 60_000;
const MISSING_RETRY_MS = 5 * 60_000;
const EMBED_TIMEOUT_MS = 60_000;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export class Indexer {
  private embedder: Embedder | null = null;
  private busyUntil = 0;
  private busy = false;
  private timer: unknown = null;
  private running = false;
  private status: IndexStatus;

  constructor(
    private readonly db: MemoryDb,
    private readonly clock: Clock = realClock,
  ) {
    this.status = { state: db.vectors ? "off" : "unavailable", model: "", done: 0, total: 0 };
  }

  /** The embedder to use (null: none); restarts the loop. */
  configure(embedder: Embedder | null): void {
    this.embedder = embedder;
    if (!this.db.vectors) return;
    this.status = embedder ? { state: "idle", model: embedder.model, ...this.db.embeddingCoverage(embedder.model) } : { state: "off", model: "", done: 0, total: 0 };
    this.schedule(0);
  }

  /** Lumi is answering or speaking: no background work meanwhile, and a few seconds after. */
  setBusy(busy: boolean): void {
    this.busy = busy;
    if (!busy) this.busyUntil = this.clock.now() + QUIET_MS;
  }

  current(): IndexStatus {
    return { ...this.status };
  }

  stop(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.embedder = null;
  }

  private schedule(ms: number): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, ms);
  }

  private async tick(): Promise<void> {
    if (!this.embedder || this.running) return;
    if (this.busy || this.clock.now() < this.busyUntil) {
      this.status.state = "waiting";
      return this.schedule(1000);
    }
    this.running = true;
    let next = IDLE_MS;
    try {
      next = (await this.step()) ? NEXT_BATCH_MS : IDLE_MS;
    } catch (err) {
      const kind = err instanceof EmbedError ? err.kind : "failed";
      this.status.state = kind === "missing" ? "missing" : kind === "offline" ? "offline" : "error";
      this.status.detail = err instanceof Error ? err.message : String(err);
      next = kind === "missing" ? MISSING_RETRY_MS : OFFLINE_RETRY_MS;
    } finally {
      this.running = false;
    }
    if (this.embedder) this.schedule(next);
  }

  /** One batch; true when there is more to do. Exposed for tests. */
  async step(): Promise<boolean> {
    const embedder = this.embedder;
    if (!embedder || !this.db.vectors) return false;
    const items = this.db.pendingEmbeddings(embedder.model, BATCH);
    if (items.length) {
      this.status.state = "indexing";
      const vectors = await embedder.embed(
        items.map((i) => i.text),
        "document",
        EMBED_TIMEOUT_MS,
      );
      // The model may have changed while waiting
      if (embedder !== this.embedder) return true;
      this.db.storeEmbeddings(embedder.model, items, vectors);
    }
    const coverage = this.db.embeddingCoverage(embedder.model);
    const complete = coverage.done >= coverage.total;
    this.status = { state: complete ? "idle" : "indexing", model: embedder.model, ...coverage };
    // Everything has vectors of the current model: older models' vectors are of no use
    if (complete) this.db.dropOtherModels(embedder.model);
    return !complete && items.length > 0;
  }
}
