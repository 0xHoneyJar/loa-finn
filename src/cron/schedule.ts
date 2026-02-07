// src/cron/schedule.ts — CronSchedule parser (SDD §4.1)

import { Cron } from "croner"
import type { CronSchedule } from "./types.js"

export type { CronSchedule }

// ISO 8601 datetime: starts with 4-digit year, dash, 2-digit month
const ISO_RE = /^\d{4}-\d{2}/

// Interval pattern: digits followed by s/m/h/d
const INTERVAL_RE = /^(\d+)(s|m|h|d)$/

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

/**
 * Parse an interval string like "30s", "5m", "1h", "2d" into milliseconds.
 * Throws on invalid format.
 */
export function parseIntervalMs(expression: string): number {
  const match = INTERVAL_RE.exec(expression)
  if (!match) {
    throw new Error(`Invalid interval expression: "${expression}"`)
  }
  const value = parseInt(match[1], 10)
  const unit = match[2]
  return value * UNIT_MS[unit]
}

/**
 * Parse a schedule string into a CronSchedule.
 * - ISO 8601 datetime → kind: "at"
 * - Interval (30s, 5m, 1h, 2d) → kind: "every"
 * - Otherwise → kind: "cron" (validated with croner)
 */
export function parseCronSchedule(input: string): CronSchedule {
  // ISO 8601 datetime
  if (ISO_RE.test(input)) {
    return { kind: "at", expression: input }
  }

  // Interval pattern
  if (INTERVAL_RE.test(input)) {
    return { kind: "every", expression: input }
  }

  // Cron expression — validate by constructing a Cron instance
  try {
    new Cron(input)
  } catch (err) {
    throw new Error(
      `Invalid cron expression: "${input}" — ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  return { kind: "cron", expression: input }
}

/**
 * Compute the next fire time in epoch ms for a given schedule.
 * Returns null if the schedule will never fire again (e.g., "at" in the past).
 */
export function computeNextRunAtMs(
  schedule: CronSchedule,
  fromMs?: number,
): number | null {
  const now = fromMs ?? Date.now()

  switch (schedule.kind) {
    case "cron": {
      const cron = new Cron(schedule.expression)
      const fromDate = new Date(now)
      const next = cron.nextRun(fromDate)
      return next ? next.getTime() : null
    }

    case "at": {
      const targetMs = new Date(schedule.expression).getTime()
      if (Number.isNaN(targetMs)) {
        throw new Error(`Invalid ISO 8601 date: "${schedule.expression}"`)
      }
      return targetMs > now ? targetMs : null
    }

    case "every": {
      const intervalMs = parseIntervalMs(schedule.expression)
      return now + intervalMs
    }

    default:
      throw new Error(`Unknown schedule kind: ${(schedule as CronSchedule).kind}`)
  }
}
