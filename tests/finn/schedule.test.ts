// tests/finn/schedule.test.ts — CronSchedule parser tests (SDD §4.1)

import assert from "node:assert/strict"
import {
  parseCronSchedule,
  computeNextRunAtMs,
  parseIntervalMs,
} from "../../src/cron/schedule.js"

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  PASS  ${name}`)
  } catch (err) {
    console.error(`  FAIL  ${name}`)
    console.error(err)
    process.exitCode = 1
  }
}

async function main() {
  console.log("CronSchedule Tests")
  console.log("==================")

  // 1. parseCronSchedule with cron expression
  await test("parseCronSchedule: cron expression → kind 'cron'", () => {
    const s = parseCronSchedule("*/5 * * * *")
    assert.equal(s.kind, "cron")
    assert.equal(s.expression, "*/5 * * * *")
  })

  // 2. parseCronSchedule with ISO datetime
  await test("parseCronSchedule: ISO datetime → kind 'at'", () => {
    const s = parseCronSchedule("2026-12-25T10:00:00Z")
    assert.equal(s.kind, "at")
    assert.equal(s.expression, "2026-12-25T10:00:00Z")
  })

  // 3. parseCronSchedule with interval "30s"
  await test("parseCronSchedule: interval '30s' → kind 'every'", () => {
    const s = parseCronSchedule("30s")
    assert.equal(s.kind, "every")
    assert.equal(s.expression, "30s")
  })

  // 4. computeNextRunAtMs with cron expression returns future timestamp
  await test("computeNextRunAtMs: cron returns future timestamp", () => {
    const schedule = parseCronSchedule("*/5 * * * *")
    const now = Date.now()
    const next = computeNextRunAtMs(schedule, now)
    assert.notEqual(next, null)
    assert.ok(next! > now, "next run should be in the future")
  })

  // 5. computeNextRunAtMs with "at" in the past returns null
  await test("computeNextRunAtMs: 'at' in the past → null", () => {
    const schedule = parseCronSchedule("2020-01-01T00:00:00Z")
    const result = computeNextRunAtMs(schedule)
    assert.equal(result, null)
  })

  // 6. computeNextRunAtMs with "at" in the future returns correct ms
  await test("computeNextRunAtMs: 'at' in the future → epoch ms", () => {
    const futureDate = "2099-06-15T12:00:00Z"
    const schedule = parseCronSchedule(futureDate)
    const result = computeNextRunAtMs(schedule, 0)
    const expected = new Date(futureDate).getTime()
    assert.equal(result, expected)
  })

  // 7. computeNextRunAtMs with "every" "5m" → fromMs + 300000
  await test("computeNextRunAtMs: 'every' 5m → fromMs + 300000", () => {
    const schedule = parseCronSchedule("5m")
    const fromMs = 1_000_000
    const result = computeNextRunAtMs(schedule, fromMs)
    assert.equal(result, fromMs + 300_000)
  })

  // 8. parseIntervalMs: all units
  await test("parseIntervalMs: 30s=30000, 5m=300000, 1h=3600000, 2d=172800000", () => {
    assert.equal(parseIntervalMs("30s"), 30_000)
    assert.equal(parseIntervalMs("5m"), 300_000)
    assert.equal(parseIntervalMs("1h"), 3_600_000)
    assert.equal(parseIntervalMs("2d"), 172_800_000)
  })

  // 9. parseIntervalMs with invalid string throws
  await test("parseIntervalMs: invalid string throws", () => {
    assert.throws(() => parseIntervalMs("abc"), /Invalid interval expression/)
    assert.throws(() => parseIntervalMs("10x"), /Invalid interval expression/)
    assert.throws(() => parseIntervalMs(""), /Invalid interval expression/)
  })

  // 10. Invalid cron expression throws
  await test("parseCronSchedule: invalid cron expression throws", () => {
    assert.throws(() => parseCronSchedule("not a cron"), /Invalid cron expression/)
  })

  console.log("\nDone.")
}

main()
