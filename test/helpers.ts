import type { Candidate } from "../src/shared/schemas";
import type { Env } from "../src/worker/env";

export const env: Env = {
  PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  NVIDIA_API_KEY: "test",
  NVIDIA_MODEL: "test-model",
  BRAVE_API_KEY: "test",
};

export function candidate(slug: string): Candidate {
  return {
    slug,
    name: `Person ${slug}`,
    headline: "Product Manager at Stripe",
    snippet: "University of Chicago · Chicago",
    url: `https://www.linkedin.com/in/${slug}`,
  };
}

/** Collects an async iterable into one string. */
export async function collect(stream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk;
  return out;
}
