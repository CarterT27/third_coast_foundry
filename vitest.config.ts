import { defineConfig } from "vitest/config";

// Separate from vite.config.ts so tests run in plain Node without starting the Worker runtime.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
