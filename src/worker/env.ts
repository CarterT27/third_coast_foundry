/** Worker bindings. Locally these come from .env; in production from `wrangler secret put`. */
export type Env = {
  PUBLIC_SUPABASE_URL: string;
  PUBLIC_SUPABASE_PUBLISHABLE_KEY: string;
  /** "nvidia" (default) or "openrouter". */
  LLM_PROVIDER?: string;
  NVIDIA_API_KEY: string;
  NVIDIA_MODEL: string;
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL: string;
  BRAVE_API_KEY: string;
};
