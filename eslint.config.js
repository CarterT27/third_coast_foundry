// Lint rules double as architecture guardrails: they stop code from reaching across
// layers. If a rule blocks you, the fix is almost never to disable it — ask the tech lead.
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

const noFetch = (message) => ["error", { name: "fetch", message }];

export default defineConfig(
  { ignores: ["dist", ".wrangler", "node_modules", "supabase"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { args: "none", ignoreRestSiblings: true }],
    },
  },

  // ─── Page ───────────────────────────────────────────────────────────────
  {
    files: ["src/web/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [{ name: "@supabase/supabase-js", message: "Use src/web/lib/supabase.ts." }],
          patterns: [
            {
              group: ["**/worker/**"],
              allowTypeImports: true,
              message: "The page may only import types from the Worker. Call the API through src/web/lib/api.ts.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/web/components/**", "src/web/App.tsx"],
    rules: { "no-restricted-globals": noFetch("Call the functions in src/web/lib/api.ts instead.") },
  },
  {
    files: ["src/web/lib/supabase.ts"],
    rules: { "@typescript-eslint/no-restricted-imports": "off" },
  },

  // ─── Worker ─────────────────────────────────────────────────────────────
  {
    files: ["src/worker/**/*.ts"],
    languageOptions: { globals: globals.serviceworker },
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: [{ group: ["**/web/**"], message: "Worker code cannot import from the page." }] },
      ],
    },
  },
  {
    files: ["src/worker/services/**"],
    rules: {
      "no-restricted-globals": noFetch("Use src/worker/lib/nvidia.ts or src/worker/lib/search-provider.ts."),
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [{ name: "@supabase/supabase-js", message: "Services never touch the database; pipeline.ts does." }],
          patterns: [
            { group: ["**/lib/db"], message: "Services never touch the database; pipeline.ts does." },
            { group: ["hono", "hono/*"], message: "Services don't know about HTTP; routes live in index.ts." },
            { group: ["**/pipeline", "**/index"], message: "Services can't import orchestration or routes." },
            { group: ["**/web/**"], message: "Worker code cannot import from the page." },
          ],
        },
      ],
    },
  },

  // ─── Shared contract ────────────────────────────────────────────────────
  {
    files: ["src/shared/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: [{ group: ["**/web/**", "**/worker/**"], message: "shared/ must not depend on either side." }] },
      ],
    },
  },

  // ─── Tests & config ─────────────────────────────────────────────────────
  {
    files: ["test/**", "*.config.{js,ts}"],
    languageOptions: { globals: globals.node },
  },
);
