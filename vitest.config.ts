import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], exclude: ["tests/browser/**"], maxWorkers: 2, testTimeout: 60_000 },
});
