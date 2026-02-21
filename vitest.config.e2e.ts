// vitest.config.e2e.ts — E2E test configuration (Sprint 1 T1.6)
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
})
