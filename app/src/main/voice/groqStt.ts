// Remote speech recognition with Groq's Whisper (free with limits, very low
// latency; the audio leaves the PC). No streaming: each utterance is sent
// whole when the turn ends.
import type { FetchLike } from "../brain/providers/compat";
import { fetchError, httpError } from "../brain/providers/compat";
import type { SttHandlers } from "./sttClient";
import { cleanTranscript, isSilence } from "./sttFilter";
import type { SttBackend } from "./turns";

const URL = "https://api.groq.com/openai/v1/audio/transcriptions";

/** A WAV file around PCM 16-bit mono samples. */
export function wav(pcm: Uint8Array, sampleRate = 16_000): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength);
  const v = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => [...text].forEach((ch, i) => v.setUint8(offset + i, ch.charCodeAt(0)));
  ascii(0, "RIFF");
  v.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

/** multipart/form-data body with text fields and one file. */
export function multipart(fields: Record<string, string>, file: { name: string; type: string; data: Uint8Array }): { body: Uint8Array; contentType: string } {
  const boundary = `----lumi${Math.random().toString(16).slice(2)}`;
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }
  parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
  parts.push(file.data);
  parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));
  const body = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const p of parts) {
    body.set(p, offset);
    offset += p.byteLength;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

export class GroqStt implements SttBackend {
  readonly partials = false;
  private readonly sessions = new Map<number, { handlers: SttHandlers; chunks: Uint8Array[]; vocabulary: string[] }>();

  constructor(
    private readonly apiKey: () => string | null,
    private readonly model: () => string,
    private readonly fetch: FetchLike,
  ) {}

  start(id: number, options: { vocabulary: string[] }, handlers: SttHandlers): boolean {
    if (!this.apiKey()) return false;
    this.sessions.set(id, { handlers, chunks: [], vocabulary: options.vocabulary });
    return true;
  }

  audio(id: number, pcm: Uint8Array): void {
    this.sessions.get(id)?.chunks.push(pcm);
  }

  cancel(id: number): void {
    this.sessions.delete(id);
  }

  end(id: number): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    const pcm = new Uint8Array(session.chunks.reduce((n, c) => n + c.byteLength, 0));
    let offset = 0;
    for (const c of session.chunks) {
      pcm.set(c, offset);
      offset += c.byteLength;
    }
    const durationMs = Math.round((pcm.byteLength / 32_000) * 1000);
    // Silence never goes out: Whisper would make something up
    if (durationMs < 200 || isSilence(pcm)) {
      session.handlers.final({ text: "", words: [], durationMs, ms: 0 });
      return;
    }
    const started = Date.now();
    void this.transcribe(pcm, session.vocabulary)
      .then((text) => session.handlers.final({ text: cleanTranscript(text, durationMs / 1000), words: [], durationMs, ms: Date.now() - started }))
      .catch((err: unknown) => session.handlers.final({ text: "", words: [], durationMs, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) }));
  }

  private async transcribe(pcm: Uint8Array, vocabulary: string[]): Promise<string> {
    const key = this.apiKey();
    if (!key) throw new Error("manca la chiave di Groq");
    const fields: Record<string, string> = { model: this.model() || "whisper-large-v3-turbo", language: "it", response_format: "json", temperature: "0" };
    if (vocabulary.length) fields.prompt = `Glossario: ${vocabulary.slice(0, 60).join(", ")}.`;
    const { body, contentType } = multipart(fields, { name: "audio.wav", type: "audio/wav", data: wav(pcm) });
    let res: Response;
    try {
      res = await this.fetch(URL, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": contentType }, body: body as unknown as BodyInit, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw fetchError(err, "Groq", false);
    }
    if (!res.ok) throw await httpError(res, "Groq");
    const result = (await res.json()) as { text?: string };
    return (result.text ?? "").trim();
  }
}
