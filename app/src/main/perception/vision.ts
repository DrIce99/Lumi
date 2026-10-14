// Local vision: a model on this PC (Ollama, or an OpenAI-compatible local
// server such as LM Studio) looks at a screenshot or an attached image and
// answers in JSON: { description, texts, regions }. The brain never gets
// the image, only that text; the regions (0-1000 normalized boxes) become
// places the eyes can look at. The OCR of the same image goes along as a
// hint: small models misread text less with it.
import type { FetchLike } from "../brain/providers/compat";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisionRegion {
  label: string;
  /** [x1, y1, x2, y2], 0-1000 across the image. */
  box: [number, number, number, number];
}

export interface VisionResult {
  description: string;
  texts: string[];
  regions: VisionRegion[];
}

export const MAX_REGIONS = 5;
const MAX_OCR_CHARS = 2500;

export const VISION_SYSTEM = `You look at an image for an assistant that cannot see. Answer with JSON only, no other text:
{"description": "...", "texts": ["..."], "regions": [{"label": "...", "box": [x1, y1, x2, y2]}]}
- description: in Italian, concrete and compact, at most 120 words: what it shows, what the user is doing, the details relevant to the request.
- texts: short pieces of visible text relevant to the request, copied exactly (at most 8).
- regions: at most ${MAX_REGIONS} important things, each with a short Italian label and its box in coordinates from 0 to 1000 across the image (x1, y1 top left, x2, y2 bottom right).
Never transcribe passwords, private messages or personal data.`;

/** The user prompt: the request and, as a hint, the OCR of the same image. */
export function visionPrompt(request: string, ocr: string[]): string {
  const parts = [request ? `Request: ${request}` : "Request: describe what is on the screen."];
  const hint = ocr.join("\n").slice(0, MAX_OCR_CHARS);
  if (hint) parts.push(`Text read by OCR in the same image (may contain errors; use it to read better):\n${hint}`);
  return parts.join("\n\n");
}

const clamp1000 = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.min(1000, Math.max(0, n)) : NaN);

/** Reads the model's answer: JSON (possibly in a code fence or with text around); plain text becomes the description. */
export function parseVisionReply(text: string): VisionResult {
  const raw = text.trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  let data: Record<string, unknown> | null = null;
  if (start >= 0 && end > start) {
    try {
      const value: unknown = JSON.parse(raw.slice(start, end + 1));
      if (value && typeof value === "object" && !Array.isArray(value)) data = value as Record<string, unknown>;
    } catch {
      data = null;
    }
  }
  if (!data) return { description: raw.replace(/^```\w*|```$/g, "").trim().slice(0, 1200), texts: [], regions: [] };
  const texts = Array.isArray(data.texts) ? data.texts.filter((t): t is string => typeof t === "string" && t.trim() !== "").map((t) => t.trim().slice(0, 200)).slice(0, 8) : [];
  const regions: VisionRegion[] = [];
  for (const r of Array.isArray(data.regions) ? data.regions : []) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const label = typeof o.label === "string" ? o.label.trim().slice(0, 80) : "";
    const b = Array.isArray(o.box) ? o.box : Array.isArray(o.bbox) ? o.bbox : Array.isArray(o.bbox_2d) ? o.bbox_2d : null;
    if (!label || !b || b.length !== 4) continue;
    const [x1, y1, x2, y2] = b.map(clamp1000);
    if ([x1, y1, x2, y2].some(Number.isNaN) || x2 <= x1 || y2 <= y1) continue;
    regions.push({ label, box: [x1, y1, x2, y2] });
    if (regions.length === MAX_REGIONS) break;
  }
  const description = typeof data.description === "string" ? data.description.trim().slice(0, 1200) : "";
  return { description, texts, regions };
}

/** A region's box on the screen: `area` is the captured rectangle (screen DIP). */
export function regionRect(region: VisionRegion, area: Rect): Rect {
  const [x1, y1, x2, y2] = region.box;
  return {
    x: Math.round(area.x + (x1 / 1000) * area.width),
    y: Math.round(area.y + (y1 / 1000) * area.height),
    width: Math.max(1, Math.round(((x2 - x1) / 1000) * area.width)),
    height: Math.max(1, Math.round(((y2 - y1) / 1000) * area.height)),
  };
}

/** What the brain reads about what was seen. */
export function describeForBrain(result: VisionResult, what: string): string {
  const lines = [`What you see on ${what}: ${result.description || "(no description)"}`];
  if (result.texts.length) lines.push(`Text there: ${result.texts.map((t) => `«${t}»`).join(", ")}`);
  if (result.regions.length) lines.push(`Things you can look at (look_at with their name): ${result.regions.map((r) => r.label).join(", ")}`);
  return lines.join("\n");
}

export interface VisionClientOptions {
  provider: "ollama" | "custom";
  /** Ollama's address, or the OpenAI-compatible server's (".../v1"). */
  url: string;
  model: string;
  /** Ollama only: how long the model stays loaded after a request ("2m"). */
  keepAlive: string;
  fetch: FetchLike;
  timeoutMs?: number;
}

export class VisionError extends Error {
  constructor(
    message: string,
    /** The model isn't there (not pulled) or the server doesn't answer: worth a hint to the user. */
    readonly kind: "offline" | "missing" | "failed",
  ) {
    super(message);
  }
}

/** One look: an image (JPEG, base64) and a request, answered by the local vision model. */
export async function askVision(options: VisionClientOptions, jpegBase64: string, prompt: string): Promise<VisionResult> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? 120_000);
  const base = options.url.replace(/\/+$/, "");
  let res: Response;
  const post = (url: string, body: unknown) =>
    options.fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  try {
    if (options.provider === "ollama") {
      const body = {
        model: options.model,
        messages: [
          { role: "system", content: VISION_SYSTEM },
          { role: "user", content: prompt, images: [jpegBase64] },
        ],
        stream: false,
        format: "json",
        think: false,
        keep_alive: options.keepAlive,
        options: { num_ctx: 8192, num_predict: 700, temperature: 0.2 },
      };
      res = await post(`${base}/api/chat`, body);
      // Models without a thinking switch reject `think`
      if (res.status === 400 && /think/i.test(await res.clone().text())) res = await post(`${base}/api/chat`, { ...body, think: undefined });
    } else {
      res = await post(`${base}/chat/completions`, {
        model: options.model,
        messages: [
          { role: "system", content: VISION_SYSTEM },
          { role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpegBase64}` } }] },
        ],
        max_tokens: 700,
        temperature: 0.2,
      });
    }
  } catch (err) {
    throw new VisionError(`the local vision server doesn't answer (${err instanceof Error ? err.message : String(err)})`, "offline");
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    const missing = res.status === 404 || /not found|pull/i.test(detail);
    throw new VisionError(`vision model error ${res.status}: ${detail}`, missing ? "missing" : "failed");
  }
  const data = (await res.json()) as { message?: { content?: string }; choices?: { message?: { content?: string } }[] };
  const text = options.provider === "ollama" ? (data.message?.content ?? "") : (data.choices?.[0]?.message?.content ?? "");
  return parseVisionReply(text);
}

/** Ollama models that can see (capability "vision" in /api/show). */
export async function listVisionModels(ollamaUrl: string, fetch: FetchLike): Promise<string[]> {
  const base = ollamaUrl.replace(/\/+$/, "");
  const tags = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(10_000) });
  if (!tags.ok) throw new Error(`Ollama: ${tags.status}`);
  const names = (((await tags.json()) as { models?: { name?: string }[] }).models ?? []).map((m) => m.name ?? "").filter(Boolean);
  const checks = await Promise.all(
    names.map(async (name) => {
      try {
        const res = await fetch(`${base}/api/show`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: name }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return false;
        const info = (await res.json()) as { capabilities?: string[] };
        return Array.isArray(info.capabilities) && info.capabilities.includes("vision");
      } catch {
        return false;
      }
    }),
  );
  return names.filter((_, i) => checks[i]);
}
