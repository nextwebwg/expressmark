import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], exclude: ["tests/browser/**"], setupFiles: ["tests/setup.ts"], maxWorkers: 2, testTimeout: 60_000 },
});
