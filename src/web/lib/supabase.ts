// The only file in the page allowed to import supabase-js.
// Visitors get an anonymous account automatically, so every row has a real owner
// from day one; later we can let them link an email or Google account.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let supabase: SupabaseClient | undefined;

// Created lazily so fixture mode works without Supabase configured.
function getClient(): SupabaseClient {
  supabase ??= createClient(import.meta.env.PUBLIC_SUPABASE_URL, import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY);
  return supabase;
}

export async function getAccessToken(): Promise<string> {
  const auth = getClient().auth;
  const { data } = await auth.getSession();
  if (data.session) return data.session.access_token;
  const { data: signIn, error } = await auth.signInAnonymously();
  if (error || !signIn.session) throw new Error(error?.message ?? "Could not start a session");
  return signIn.session.access_token;
}
