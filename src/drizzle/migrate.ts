// src/drizzle/migrate.ts — Migration runner entrypoint (Sprint 1 T1.3)
// Compiled to dist/drizzle/migrate.js, invoked by docker compose as:
//   node dist/drizzle/migrate.js

import { drizzle } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import postgres from "postgres"

async function runMigrations() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error("[finn-migrate] DATABASE_URL is required")
    process.exit(1)
  }

  console.log("[finn-migrate] connecting to database...")
  const sql = postgres(connectionString, { max: 1 })

  try {
    const db = drizzle(sql)
    console.log("[finn-migrate] running migrations...")
    await migrate(db, { migrationsFolder: "drizzle" })
    console.log("[finn-migrate] migrations complete")
  } catch (err) {
    console.error("[finn-migrate] migration failed:", err)
    process.exit(1)
  } finally {
    await sql.end()
  }
}

runMigrations()
