// Ollama's native chat API. Used instead of its OpenAI-compatible endpoint
// because only the native one lets us enlarge the context window: with the
// small default, Ollama would silently cut the start of the system prompt.
import {
  defaultFetch,
  fetchError,
  httpError,
  lines,
  type ChatTransport,
  type FetchLike,
  type SimpleMessage,
  type StreamDelta,
  type StreamOutcome,
  type StreamRequest,
} from "./compat";
import { ProviderError } from "./types";

const CONTEXT_TOKENS = 8192;
/** Keeps the model loaded between turns: reloading it costs seconds of latency. */
const KEEP_ALIVE = "15m";

interface OllamaChunk {
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: { function?: { name?: string; arguments?: unknown } }[];
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export class OllamaTransport implements ChatTransport {
  /** Models that reject the `think` option (not thinking-capable, or level-only). */
  private readonly noThinkOption = new Set<string>();

  constructor(
    private readonly baseUrl: string,
    private readonly fetch: FetchLike = defaultFetch,
    private readonly apiKey: string | null = null,
  ) {}

  async stream(request: StreamRequest, onDelta: (delta: StreamDelta) => void, signal: AbortSignal): Promise<StreamOutcome> {
    try {
      return await this.send(request, onDelta, signal, !this.noThinkOption.has(request.model));
    } catch (err) {
      if (err instanceof ProviderError && err.kind === "bad_request" && /think/i.test(err.message)) {
        this.noThinkOption.add(request.model);
        return this.send(request, onDelta, signal, false);
      }
      throw err;
    }
  }

  async listModels(): Promise<string[]> {
    const res = await this.fetch(`${this.baseUrl}/api/tags`, { headers: this.headers(), signal: AbortSignal.timeout(20_000) }).catch((err: unknown) => {
      throw fetchError(err, "Ollama", false);
    });
    if (!res.ok) throw await httpError(res, "Ollama");
    const body = (await res.json()) as { models?: { name?: string }[] };
    return (body.models ?? []).map((m) => m.name ?? "").filter(Boolean);
  }

  private async send(request: StreamRequest, onDelta: (delta: StreamDelta) => void, signal: AbortSignal, disableThinking: boolean): Promise<StreamOutcome> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(toOllama),
      stream: true,
      keep_alive: KEEP_ALIVE,
      options: { num_ctx: CONTEXT_TOKENS, num_predict: request.maxTokens },
    };
    if (request.tools) {
      body.tools = request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    if (request.json) body.format = "json";
    // A voice needs a fast first word, not long reasoning: answer directly where the model allows it
    if (disableThinking) body.think = false;

    let res: Response;
    try {
      res = await this.fetch(`${this.baseUrl}/api/chat`, { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal });
    } catch (err) {
      throw fetchError(err, "Ollama", signal.aborted && signal.reason?.name !== "TimeoutError");
    }
    if (!res.ok || !res.body) throw await httpError(res, "Ollama");

    let finish: StreamOutcome["finish"] = "stop";
    let usage: StreamOutcome["usage"] = null;
    let calls = 0;
    try {
      for await (const line of lines(res.body)) {
        if (!line.trim()) continue;
        let chunk: OllamaChunk;
        try {
          chunk = JSON.parse(line) as OllamaChunk;
        } catch {
          continue;
        }
        if (chunk.error) throw new ProviderError("bad_request", `Ollama: ${chunk.error}`);
        if (chunk.message?.content) onDelta({ text: chunk.message.content });
        for (const call of chunk.message?.tool_calls ?? []) {
          const index = calls++;
          onDelta({ tool: { index, id: `call_${index + 1}`, name: call.function?.name, args: JSON.stringify(call.function?.arguments ?? {}) } });
        }
        if (chunk.done) {
          if (chunk.done_reason === "length") finish = "length";
          usage = { input_tokens: chunk.prompt_eval_count ?? 0, output_tokens: chunk.eval_count ?? 0 };
        }
      }
    } catch (err) {
      throw fetchError(err, "Ollama", signal.aborted && signal.reason?.name !== "TimeoutError");
    }
    return { finish: calls && finish === "stop" ? "tool_calls" : finish, usage };
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }
}

function toOllama(m: SimpleMessage): Record<string, unknown> {
  switch (m.role) {
    case "system":
      return { role: "system", content: m.text };
    case "user":
      return { role: "user", content: m.text, ...(m.images?.length ? { images: m.images } : {}) };
    case "assistant":
      return {
        role: "assistant",
        content: m.text,
        ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: parseObject(c.args) } })) } : {}),
      };
    case "tool":
      return { role: "tool", content: m.text, tool_name: m.name };
  }
}

function parseObject(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
