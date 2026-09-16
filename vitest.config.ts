import { defineConfig } from "vitest/config";

// Deliberately standalone — does NOT extend vite.config.ts, since that config
// loads the Cloudflare Workers Vite plugin, which is incompatible with
// Vitest's default Node test environment. These tests only exercise plain
// TypeScript in lib/, so no Workers-specific tooling is needed here.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
