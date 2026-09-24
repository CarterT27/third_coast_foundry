import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { chat, chatJSON, chatStream } from "../src/worker/lib/llm";
import { collect, env } from "./helpers";

const openrouter = { ...env, LLM_PROVIDER: "openrouter" };

function reply(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

function completion(content: string) {
  return reply({ choices: [{ message: { content } }] });
}

function stream(events: unknown[]) {
  const text = events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");
  return new Response(`: OPENROUTER PROCESSING\n\n${text}`, { status: 200 });
}

function mockFetch(...responses: Response[]) {
  const fn = vi.fn<typeof fetch>();
  for (const res of responses) fn.mockResolvedValueOnce(res);
  vi.stubGlobal("fetch", fn);
  return fn;
}

function sent(fn: ReturnType<typeof mockFetch>, call = 0) {
  const [url, init] = fn.mock.calls[call] ?? [];
  const headers = new Headers(init?.headers);
  return { url, auth: headers.get("Authorization"), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider selection", () => {
  it("defaults to NVIDIA with thinking disabled", async () => {
    const fn = mockFetch(completion("hi"));
    await expect(chat(env, [{ role: "user", content: "hey" }])).resolves.toBe("hi");
    const req = sent(fn);
    expect(req.url).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    expect(req.auth).toBe("Bearer test");
    expect(req.body.model).toBe("test-model");
    expect(req.body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(req.body).not.toHaveProperty("reasoning");
  });

  it("uses OpenRouter when LLM_PROVIDER=openrouter", async () => {
    const fn = mockFetch(completion("hi"));
    await chat(openrouter, [{ role: "user", content: "hey" }]);
    const req = sent(fn);
    expect(req.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(req.auth).toBe("Bearer test-or");
    expect(req.body.model).toBe("test-or-model");
    expect(req.body.reasoning).toEqual({ enabled: false });
    expect(req.body.provider).toEqual({ sort: "latency", data_collection: "deny" });
    expect(req.body).not.toHaveProperty("chat_template_kwargs");
  });

  it("rejects an unknown provider", async () => {
    mockFetch();
    await expect(chat({ ...env, LLM_PROVIDER: "nope" }, [])).rejects.toThrow(/Unknown LLM_PROVIDER "nope"/);
  });
});

describe("OpenRouter responses", () => {
  it("requires response_format support for chatJSON", async () => {
    const fn = mockFetch(completion('{"ok":true}'));
    await expect(chatJSON(openrouter, [], z.object({ ok: z.boolean() }))).resolves.toEqual({ ok: true });
    const req = sent(fn);
    expect(req.body.provider).toEqual({ sort: "latency", data_collection: "deny", require_parameters: true });
    expect(req.body.response_format).toMatchObject({ type: "json_schema" });
  });

  it("throws on a 200 response with an error body", async () => {
    mockFetch(reply({ error: { code: 502, message: "upstream down" } }));
    await expect(chat(openrouter, [])).rejects.toThrow("OpenRouter API error: upstream down");
  });

  it("streams text and skips keep-alive comments", async () => {
    mockFetch(stream([{ choices: [{ delta: { content: "Hel" } }] }, { choices: [{ delta: { content: "lo" } }] }, "[DONE]"]));
    await expect(collect(chatStream(openrouter, []))).resolves.toBe("Hello");
  });

  it("throws on a mid-stream error chunk", async () => {
    mockFetch(stream([{ choices: [{ delta: { content: "Hel" } }] }, { error: { message: "provider died" } }]));
    await expect(collect(chatStream(openrouter, []))).rejects.toThrow("OpenRouter API stream error: provider died");
  });

  it("names the provider in HTTP errors", async () => {
    mockFetch(new Response("bad key", { status: 401 }));
    await expect(chat(openrouter, [])).rejects.toThrow("OpenRouter API 401: bad key");
  });
});

describe("timeouts", () => {
  const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

  it("sends every request with a timeout signal and retries one that times out", async () => {
    const fn = vi.fn<typeof fetch>().mockRejectedValueOnce(timeout()).mockResolvedValueOnce(completion("hi"));
    vi.stubGlobal("fetch", fn);
    await expect(chat(env, [{ role: "user", content: "hey" }])).resolves.toBe("hi");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("gives up with a readable error after every attempt times out", async () => {
    const fn = vi.fn<typeof fetch>().mockRejectedValue(timeout());
    vi.stubGlobal("fetch", fn);
    await expect(chat(env, [{ role: "user", content: "hey" }])).rejects.toThrow("NVIDIA API timed out after 60s");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("doesn't retry other network errors", async () => {
    const fn = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fn);
    await expect(chat(env, [{ role: "user", content: "hey" }])).rejects.toThrow("fetch failed");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
