// Worker thread that owns memory.db: SQLite calls are synchronous, and the
// main thread must never wait on them (the click-through mouse hook runs
// there). Requests are handled one at a time, in the order they arrive, so
// lines keep their order in the log.
import { parentPort, workerData } from "node:worker_threads";
import { MemoryDb } from "./db";
import { STORE_METHODS, type StoreMethod, type StoreReply, type StoreRequest } from "./store";

const port = parentPort!;
let db: MemoryDb | null = null;
let openError = "";
try {
  db = new MemoryDb((workerData as { file: string }).file);
} catch (err) {
  openError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

port.on("message", (request: StoreRequest) => {
  let reply: StoreReply;
  try {
    if (!db) throw new Error(`memory.db can't be opened (${openError})`);
    if (!(STORE_METHODS as readonly string[]).includes(request.method)) throw new Error(`unknown method ${request.method}`);
    const method = db[request.method as StoreMethod] as (...args: unknown[]) => unknown;
    reply = { id: request.id, result: method.apply(db, request.args) };
  } catch (err) {
    reply = { id: request.id, error: err instanceof Error ? err.message : String(err) };
  }
  port.postMessage(reply);
  if (request.method === "close") process.exit(0);
});
