import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), cloudflare()],
  // Only PUBLIC_* variables from .env are exposed to browser code.
  envPrefix: "PUBLIC_",
  // React + supabase-js + zod land around 550 kB before gzip; pdf.js is lazy-loaded separately.
  build: { chunkSizeWarningLimit: 800 },
});
