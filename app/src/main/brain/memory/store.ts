// The main thread's handle on memory.db: every call goes to the worker
// thread (worker.ts) and comes back as a promise. Writes are fire and
// forget; the worker runs requests in order, so `settled()` resolves once
// everything sent before it is on disk. Tests use an in-process database.
import { Worker } from "node:worker_threads";
import { log } from "../../log";
import type { LegacyImport, LineInput, MemoryDb, SearchRequest, SearchResult, StoredLine, SummaryInput } from "./db";

export const STORE_METHODS = ["append", "addSummary", "between", "count", "search", "importLegacy", "clear", "close"] as const;
export type StoreMethod = (typeof STORE_METHODS)[number];

export interface StoreRequest {
  id: number;
  method: StoreMethod | "ping";
  args: unknown[];
}

export type StoreReply = { id: number; result?: unknown; error?: string };

type Call = (method: StoreRequest["method"], args: unknown[]) => Promise<unknown>;

export class MemoryStore {
  private failed = false;

  constructor(private readonly call: Call) {}

  /** A store backed by the worker thread (the app). `script`: the bundled worker.ts. */
  static open(file: string, script: string): MemoryStore {
    const worker = new Worker(script, { workerData: { file } });
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    let next = 1;
    let dead = false;
    worker.on("message", (reply: StoreReply) => {
      const p = pending.get(reply.id);
      if (!p) return;
      pending.delete(reply.id);
      if (reply.error !== undefined) p.reject(new Error(reply.error));
      else p.resolve(reply.result);
    });
    const fail = (err: Error) => {
      dead = true;
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    };
    worker.on("error", (err) => {
      log.error("The memory worker failed", err);
      fail(err);
    });
    worker.on("exit", (code) => fail(new Error(`memory worker exited (${code})`)));
    worker.unref();
    return new MemoryStore((method, args) => {
      if (dead) return Promise.reject(new Error("memory worker not running"));
      const id = next++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, method, args } satisfies StoreRequest);
      });
    });
  }

  /** A store on a database in this thread (tests). */
  static local(db: MemoryDb): MemoryStore {
    return new MemoryStore(async (method, args) => {
      if (method === "ping") return null;
      return (db[method] as (...a: unknown[]) => unknown).apply(db, args);
    });
  }

  /** Appends a line to the raw log (fire and forget). */
  append(line: LineInput, channel?: string): void {
    this.write("append", [line, channel]);
  }

  addSummary(summary: SummaryInput): void {
    this.write("addSummary", [summary]);
  }

  /** Searches memory; a slow or failed search is no result (`null` after `timeoutMs`). */
  async search(request: SearchRequest, timeoutMs = 2000): Promise<SearchResult | null> {
    try {
      return await withTimeout(this.call("search", [request]) as Promise<SearchResult>, timeoutMs);
    } catch (err) {
      this.report("Memory search failed", err);
      return null;
    }
  }

  /** Lines in [from, to) (ISO), oldest first; empty when the store is unavailable. */
  async between(from: string, to: string): Promise<StoredLine[]> {
    try {
      return (await this.call("between", [from, to])) as StoredLine[];
    } catch (err) {
      this.report("Reading the memory log failed", err);
      return [];
    }
  }

  async count(): Promise<{ messages: number; summaries: number } | null> {
    return (this.call("count", []) as Promise<{ messages: number; summaries: number }>).catch(() => null);
  }

  /** Imports the old archive once; rejects when the database can't take it. */
  importLegacy(data: LegacyImport): Promise<number> {
    return this.call("importLegacy", [data]) as Promise<number>;
  }

  clear(): Promise<void> {
    return (this.call("clear", []) as Promise<void>).catch((err: unknown) => this.report("Clearing memory.db failed", err));
  }

  /** Resolves once every request sent before it was handled. */
  settled(): Promise<void> {
    return this.call("ping", []).then(
      () => undefined,
      () => undefined,
    );
  }

  close(): Promise<void> {
    return this.call("close", []).then(
      () => undefined,
      () => undefined,
    );
  }

  private write(method: StoreMethod, args: unknown[]): void {
    this.call(method, args).catch((err: unknown) => this.report("Writing to memory.db failed", err));
  }

  /** Logs the first failure only: a broken database would otherwise flood the log. */
  private report(what: string, err: unknown): void {
    if (this.failed) return;
    this.failed = true;
    log.error(what, err);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
