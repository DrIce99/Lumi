// Worker thread that owns memory.db: SQLite calls are synchronous, and the
// main thread must never wait on them (the click-through mouse hook runs
// there). Requests are handled in the order they arrive, so lines keep
// their order in the log; only a search may wait (for its query's
// embedding), and writes go on meanwhile. The embedding queue runs here
// too (indexer.ts).
import { parentPort, workerData } from "node:worker_threads";
import { makeBackup } from "./backup";
import { MemoryDb, type SearchRequest, type SearchResult } from "./db";
import { EmbedError, OllamaEmbedder, type Embedder } from "./embed";
import { Indexer } from "./indexer";
import { DEFAULT_WEIGHTS, type ScoreWeights } from "./search";
import { STORE_METHODS, type EmbeddingConfig, type StoreReply, type StoreRequest } from "./store";

const port = parentPort!;
const data = workerData as { file: string; vecExtension: string | null };
let db: MemoryDb | null = null;
let indexer: Indexer | null = null;
let openError = "";
try {
  db = new MemoryDb(data.file, { vecExtension: data.vecExtension });
  indexer = new Indexer(db);
} catch (err) {
  openError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

let embedder: Embedder | null = null;
let weights: ScoreWeights = DEFAULT_WEIGHTS;
let warmedAt = 0;
/** One warm-up a minute is plenty: Ollama keeps the model loaded for minutes. */
const WARM_EVERY_MS = 60_000;

/** Calls that are not plain MemoryDb methods. */
const special: Record<string, (...args: never[]) => unknown> = {
  configure: (config: EmbeddingConfig) => {
    embedder = config.provider === "ollama" && config.model ? new OllamaEmbedder(config.url, config.model, config.keepAlive) : null;
    weights = config.weights ?? DEFAULT_WEIGHTS;
    indexer!.configure(embedder);
    return indexer!.current();
  },
  setBusy: (busy: boolean) => indexer!.setBusy(busy),
  indexStatus: () => indexer!.current(),
  ping: () => null,
  warm: () => {
    if (!embedder || Date.now() - warmedAt < WARM_EVERY_MS) return;
    warmedAt = Date.now();
    void embedder.embed(["ok"], "query", 60_000).catch(() => undefined);
  },
  search: async (request: SearchRequest): Promise<SearchResult> => {
    let query = null;
    // Meaning as well as words, when the query's embedding comes quickly enough
    if (request.query && embedder && db!.vectors) {
      try {
        const [vector] = await embedder.embed([request.query], "query", request.embedTimeoutMs ?? 3000);
        query = { model: embedder.model, vector };
      } catch (err) {
        if (!(err instanceof EmbedError)) throw err;
      }
    }
    return db!.search(request, query, { weights });
  },
  findForForget: async (query: string) => {
    let vector = null;
    if (embedder && db!.vectors) {
      try {
        vector = { model: embedder.model, vector: (await embedder.embed([query], "query", 5000))[0] };
      } catch (err) {
        if (!(err instanceof EmbedError)) throw err;
      }
    }
    return db!.findForForget(query, vector);
  },
  backup: (dir: string, keep: number, reset: boolean) => makeBackup(db!, dir, keep, reset),
  close: () => {
    indexer?.stop();
    db?.close();
  },
};

port.on("message", async (request: StoreRequest) => {
  let reply: StoreReply;
  try {
    if (!db) throw new Error(`memory.db can't be opened (${openError})`);
    if (!(STORE_METHODS as readonly string[]).includes(request.method)) throw new Error(`unknown method ${request.method}`);
    const fn = (special[request.method] ?? (db[request.method as keyof MemoryDb] as (...args: unknown[]) => unknown).bind(db)) as (...args: unknown[]) => unknown;
    reply = { id: request.id, result: await fn(...request.args) };
  } catch (err) {
    reply = { id: request.id, error: err instanceof Error ? err.message : String(err) };
  }
  port.postMessage(reply);
  if (request.method === "close") process.exit(0);
});
