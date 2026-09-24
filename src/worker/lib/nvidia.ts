// The only place the app talks to the NVIDIA API (OpenAI-compatible chat completions).
// Services call chat / chatJSON / chatStream; they never call fetch themselves.
import { z } from "zod";
import { readSSE } from "../../shared/sse";
import type { Env } from "../env";

const BASE_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const MAX_ATTEMPTS = 3;

export type LLMMessage = { role: "system" | "user" | "assistant"; content: string };
export type ChatOptions = { temperature?: number; maxTokens?: number };

/** One completion, returned as plain text. */
export async function chat(env: Env, messages: LLMMessage[], opts: ChatOptions = {}): Promise<string> {
  const res = await request(env, { messages, ...params(env, opts) });
  const json = (await res.json()) as { choices: { message: { content: string | null } }[] };
  return stripThinking(json.choices[0]?.message.content ?? "");
}

/**
 * One completion parsed and validated against `schema`. The JSON schema is sent as
 * response_format so the model is constrained to it; retries once if validation still fails.
 */
export async function chatJSON<T extends z.ZodType>(
  env: Env,
  messages: LLMMessage[],
  schema: T,
  opts: ChatOptions = {},
): Promise<z.infer<T>> {
  const body = {
    messages,
    ...params(env, { temperature: 0, ...opts }),
    response_format: {
      type: "json_schema",
      json_schema: { name: "response", schema: z.toJSONSchema(schema) },
    },
  };
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await request(env, body);
    const json = (await res.json()) as { choices: { message: { content: string | null } }[] };
    const text = stripThinking(json.choices[0]?.message.content ?? "");
    try {
      return schema.parse(JSON.parse(extractJSON(text)));
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`LLM returned invalid JSON: ${String(lastError)}`);
}

/** Streams a completion, yielding text chunks as they arrive. */
export async function* chatStream(
  env: Env,
  messages: LLMMessage[],
  opts: ChatOptions = {},
): AsyncGenerator<string> {
  const res = await request(env, { messages, ...params(env, opts), stream: true });
  if (!res.body) throw new Error("NVIDIA API returned an empty stream");
  for await (const data of readSSE(res.body)) {
    if (data === "[DONE]") return;
    const chunk = JSON.parse(data) as { choices: { delta: { content?: string | null } }[] };
    const text = chunk.choices[0]?.delta.content;
    if (text) yield text;
  }
}

function params(env: Env, opts: ChatOptions) {
  return {
    model: env.NVIDIA_MODEL,
    temperature: opts.temperature ?? 0.4,
    max_tokens: opts.maxTokens ?? 2048,
    // Reasoning models (e.g. Nemotron) otherwise write their thinking into the reply.
    chat_template_kwargs: { enable_thinking: false },
  };
}

async function request(env: Env, body: unknown): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(BASE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.NVIDIA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return res;
    // The free tier is rate limited; back off and retry on 429 / 5xx.
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      throw new Error(`NVIDIA API ${res.status}: ${await res.text()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
  }
}

/** Reasoning models may prefix answers with <think>…</think>. */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/** Tolerates ```json fences or prose around the JSON object. */
function extractJSON(text: string): string {
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  return start === -1 || end < start ? text : text.slice(start, end + 1);
}
