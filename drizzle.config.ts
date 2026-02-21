// drizzle.config.ts — Drizzle Kit configuration (Sprint 1 T1.3)
import { defineConfig } from "drizzle-kit"

export default defineConfig({
  schema: "./src/drizzle/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://finn_migrate:finn_migrate_dev@localhost:5433/finn",
  },
})
