// src/drizzle/db.ts — Database connection factory (Sprint 1 T1.3)

import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema.js"

export interface DbOptions {
  connectionString: string
  /** Maximum connections in pool (default: 10) */
  maxConnections?: number
}

/**
 * Create a Drizzle ORM database instance connected to PostgreSQL.
 * Returns both the drizzle db instance and the underlying sql client
 * (needed for graceful shutdown).
 */
export function createDb(options: DbOptions) {
  const sql = postgres(options.connectionString, {
    max: options.maxConnections ?? 10,
    idle_timeout: 20,
    connect_timeout: 10,
  })

  const db = drizzle(sql, { schema })

  return { db, sql }
}

export type Db = ReturnType<typeof createDb>["db"]
