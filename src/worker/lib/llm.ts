// The only place the app talks to an LLM API. NVIDIA and OpenRouter both speak OpenAI-style
// chat completions; LLM_PROVIDER picks one (default NVIDIA).
// Services call chat / chatJSON / chatStream; they never call fetch themselves.
import { z } from "zod";
import { readSSE } from "../../shared/sse";
import type { Env } from "../env";

const MAX_ATTEMPTS = 3;

type Provider = {
  name: string;
  url: string;
  key: (env: Env) => string;
  model: (env: Env) => string;
  headers?: Record<string, string>;
  /** Provider-specific body fields sent with every request. */
  extra: Record<string, unknown>;
  /** Extra body fields for chatJSON requests. */
  jsonExtra?: Record<string, unknown>;
};

const PROVIDERS = {
  nvidia: {
    name: "NVIDIA",
    url: "https://integrate.api.nvidia.com/v1/chat/completions",
    key: (env) => env.NVIDIA_API_KEY,
    model: (env) => env.NVIDIA_MODEL,
    // Reasoning models (e.g. Nemotron) otherwise write their thinking into the reply.
    extra: { chat_template_kwargs: { enable_thinking: false } },
  },
  openrouter: {
    name: "OpenRouter",
    url: "https://openrouter.ai/api/v1/chat/completions",
    key: (env) => env.OPENROUTER_API_KEY,
    model: (env) => env.OPENROUTER_MODEL,
    headers: { "X-Title": "Third Coast Foundry" },
    // Thinking off, and route to whichever host currently answers fastest.
    extra: { reasoning: { enabled: false }, provider: { sort: "latency" } },
    // Only route JSON calls to hosts that honor response_format.
    jsonExtra: { provider: { sort: "latency", require_parameters: true } },
  },
} satisfies Record<string, Provider>;

function provider(env: Env): Provider {
  const name = env.LLM_PROVIDER || "nvidia";
  if (!Object.hasOwn(PROVIDERS, name)) {
    throw new Error(`Unknown LLM_PROVIDER "${name}" (use ${Object.keys(PROVIDERS).join(" or ")})`);
  }
  return PROVIDERS[name as keyof typeof PROVIDERS];
}

type Completion = { choices?: { message: { content: string | null } }[]; error?: { message?: string } };
type Chunk = { choices?: { delta: { content?: string | null } }[]; error?: { message?: string } };

export type LLMMessage = { role: "system" | "user" | "assistant"; content: string };
export type ChatOptions = { temperature?: number; maxTokens?: number };

/** One completion, returned as plain text. */
export async function chat(env: Env, messages: LLMMessage[], opts: ChatOptions = {}): Promise<string> {
  const res = await request(env, { messages, ...params(env, opts) });
  return content(env, (await res.json()) as Completion);
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
    ...provider(env).jsonExtra,
    response_format: {
      type: "json_schema",
      json_schema: { name: "response", schema: z.toJSONSchema(schema) },
    },
  };
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await request(env, body);
    const text = content(env, (await res.json()) as Completion);
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
  const { name } = provider(env);
  if (!res.body) throw new Error(`${name} API returned an empty stream`);
  for await (const data of readSSE(res.body)) {
    if (data === "[DONE]") return;
    const chunk = JSON.parse(data) as Chunk;
    // OpenRouter reports failures after the stream has started as an error chunk.
    if (chunk.error) throw new Error(`${name} API stream error: ${chunk.error.message ?? "unknown"}`);
    const text = chunk.choices?.[0]?.delta.content;
    if (text) yield text;
  }
}

function params(env: Env, opts: ChatOptions) {
  const p = provider(env);
  return {
    model: p.model(env),
    temperature: opts.temperature ?? 0.4,
    max_tokens: opts.maxTokens ?? 2048,
    ...p.extra,
  };
}

/** Text of a non-streamed completion. OpenRouter can return 200 with an error body. */
function content(env: Env, json: Completion): string {
  if (json.error) throw new Error(`${provider(env).name} API error: ${json.error.message ?? "unknown"}`);
  return stripThinking(json.choices?.[0]?.message.content ?? "");
}

async function request(env: Env, body: unknown): Promise<Response> {
  const p = provider(env);
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(p.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${p.key(env)}`,
        "Content-Type": "application/json",
        ...p.headers,
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return res;
    // Both APIs rate limit; back off and retry on 429 / 5xx.
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      throw new Error(`${p.name} API ${res.status}: ${await res.text()}`);
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
