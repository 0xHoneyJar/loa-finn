// src/drizzle/validate.ts — Database startup validation gate (Sprint 1 T1.4)
// On boot (when FINN_POSTGRES_ENABLED=true), verify required tables exist.
// If any are missing, exit with code 1 and a clear error message.

import type { Sql } from "postgres"

const REQUIRED_TABLES = [
  "finn_api_keys",
  "finn_billing_events",
  "finn_verification_failures",
] as const

/**
 * Validate that all required tables exist in the finn schema.
 * Exits process with code 1 if any table is missing.
 */
export async function validateDatabase(sql: Sql): Promise<void> {
  const result = await sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'finn'
      AND table_type = 'BASE TABLE'
  `

  const existingTables = new Set(result.map((row) => row.table_name))
  const missing = REQUIRED_TABLES.filter((t) => !existingTables.has(t))

  if (missing.length > 0) {
    console.error(`[finn] FATAL: Required tables missing from finn schema: ${missing.join(", ")}`)
    console.error("[finn] Run migrations first: docker compose run finn-migrate")
    process.exit(1)
  }

  console.log(`[finn] database validated: ${REQUIRED_TABLES.length} tables present in finn schema`)
}
