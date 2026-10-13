// OpenAI-compatible chat completions (Groq, Gemini, OpenRouter, LM Studio...),
// streamed as server-sent events.
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

interface ChunkToolCall {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
  /** Gemini: thought signature to send back with the call. */
  extra_content?: unknown;
}

interface ChunkChoice {
  delta?: {
    content?: string | null;
    tool_calls?: ChunkToolCall[];
  };
  finish_reason?: string | null;
}

interface Chunk {
  choices?: ChunkChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string; code?: number | string };
}

export class OpenAITransport implements ChatTransport {
  /** Options some services reject; remembered per model so they're sent once. */
  private readonly noJsonFormat = new Set<string>();
  private readonly noUsageOption = new Set<string>();

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | null,
    private readonly service: string,
    private readonly extraHeaders: Record<string, string> = {},
    private readonly fetch: FetchLike = defaultFetch,
  ) {}

  async stream(request: StreamRequest, onDelta: (delta: StreamDelta) => void, signal: AbortSignal): Promise<StreamOutcome> {
    for (;;) {
      try {
        return await this.send(request, onDelta, signal);
      } catch (err) {
        if (!(err instanceof ProviderError) || err.kind !== "bad_request") throw err;
        if (request.json && !this.noJsonFormat.has(request.model) && /response_format|json_object/i.test(err.message)) {
          this.noJsonFormat.add(request.model);
        } else if (!this.noUsageOption.has(request.model) && /stream_options|include_usage/i.test(err.message)) {
          this.noUsageOption.add(request.model);
        } else {
          throw err;
        }
      }
    }
  }

  async listModels(): Promise<string[]> {
    const res = await this.fetch(`${this.baseUrl}/models`, { headers: this.headers(), signal: AbortSignal.timeout(20_000) }).catch((err: unknown) => {
      throw fetchError(err, this.service, false);
    });
    if (!res.ok) throw await httpError(res, this.service);
    const body = (await res.json()) as { data?: { id?: string }[]; models?: { name?: string }[] };
    const ids = (body.data ?? []).map((m) => m.id ?? "").concat((body.models ?? []).map((m) => m.name ?? ""));
    return ids.map((id) => id.replace(/^models\//, "")).filter(Boolean);
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      ...this.extraHeaders,
    };
  }

  private async send(request: StreamRequest, onDelta: (delta: StreamDelta) => void, signal: AbortSignal): Promise<StreamOutcome> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(toOpenAI),
      stream: true,
      max_tokens: request.maxTokens,
    };
    // Without this, most services don't report token usage when streaming
    if (!this.noUsageOption.has(request.model)) body.stream_options = { include_usage: true };
    if (request.tools) {
      body.tools = request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = "auto";
    }
    if (request.json && !this.noJsonFormat.has(request.model)) body.response_format = { type: "json_object" };

    let res: Response;
    try {
      res = await this.fetch(`${this.baseUrl}/chat/completions`, { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal });
    } catch (err) {
      throw fetchError(err, this.service, signal.aborted && signal.reason?.name !== "TimeoutError");
    }
    if (!res.ok || !res.body) throw await httpError(res, this.service);

    let finish: StreamOutcome["finish"] = "stop";
    let usage: StreamOutcome["usage"] = null;
    let sawToolCall = false;
    // Gemini sends each tool call whole and without `index`: tell them apart by id
    const slots = new Map<string, number>();
    let lastSlot: number | null = null;
    const slotOf = (call: ChunkToolCall, position: number): number => {
      if (call.index !== undefined) return call.index;
      if (!call.id) return lastSlot ?? position;
      let slot = slots.get(call.id);
      if (slot === undefined) {
        slot = slots.size;
        slots.set(call.id, slot);
      }
      return slot;
    };
    try {
      for await (const line of lines(res.body)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let chunk: Chunk;
        try {
          chunk = JSON.parse(data) as Chunk;
        } catch {
          continue;
        }
        if (chunk.error) throw new ProviderError("bad_request", `${this.service}: ${chunk.error.message ?? "error"}`);
        if (chunk.usage) usage = { input_tokens: chunk.usage.prompt_tokens ?? 0, output_tokens: chunk.usage.completion_tokens ?? 0 };
        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta;
          if (delta?.content) onDelta({ text: delta.content });
          delta?.tool_calls?.forEach((call, position) => {
            sawToolCall = true;
            lastSlot = slotOf(call, position);
            onDelta({ tool: { index: lastSlot, id: call.id, name: call.function?.name, args: call.function?.arguments, extra: call.extra_content } });
          });
          if (choice.finish_reason) {
            const reason = choice.finish_reason;
            finish = reason === "length" ? "length" : reason === "content_filter" ? "content_filter" : reason === "tool_calls" || reason === "function_call" ? "tool_calls" : "stop";
          }
        }
      }
    } catch (err) {
      throw fetchError(err, this.service, signal.aborted && signal.reason?.name !== "TimeoutError");
    }
    return { finish: sawToolCall && finish === "stop" ? "tool_calls" : finish, usage };
  }
}

function toOpenAI(m: SimpleMessage): Record<string, unknown> {
  switch (m.role) {
    case "system":
      return { role: "system", content: m.text };
    case "user":
      return m.images?.length
        ? {
            role: "user",
            content: [{ type: "text", text: m.text }, ...m.images.map((b64) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } }))],
          }
        : { role: "user", content: m.text };
    case "assistant":
      return m.toolCalls?.length
        ? {
            role: "assistant",
            content: m.text || null,
            tool_calls: m.toolCalls.map((c) => ({
              id: c.id,
              type: "function",
              function: { name: c.name, arguments: c.args || "{}" },
              ...(c.extra !== undefined ? { extra_content: c.extra } : {}),
            })),
          }
        : { role: "assistant", content: m.text };
    case "tool":
      return { role: "tool", tool_call_id: m.id, content: m.text };
  }
}
