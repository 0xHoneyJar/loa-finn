// src/safety/__tests__/audit.test.ts — Audit Trail Safety Tests (PRD Section 7)
// AU-01 through AU-05: validates audit trail integrity claims.

import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { AuditTrail } from "../../safety/audit-trail.js"

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

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "finn-audit-test-"))
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true })
}

function readRecords(filePath: string): Record<string, unknown>[] {
  const content = readFileSync(filePath, "utf-8").trim()
  if (!content) return []
  return content.split("\n").map((line) => JSON.parse(line))
}

const CTX = { jobId: "j1", runUlid: "u1", templateId: "t1" }
const INPUT = { action: "create_issue", target: "o/r#_", params: { owner: "o", repo: "r" } }

async function main() {
  console.log("Audit Trail Safety Tests (AU-01 through AU-05)")
  console.log("================================================")

  await test("AU-01: Intent recorded BEFORE result (seq numbers link correctly)", async () => {
    const dir = makeTempDir()
    const fp = join(dir, "audit.jsonl")
    try {
      const trail = new AuditTrail(fp)
      trail.setRunContext(CTX)
      const intentSeq = await trail.recordIntent(INPUT)
      const resultSeq = await trail.recordResult(intentSeq, {
        action: "create_issue", target: "o/r#_", params: {}, result: { id: 42 },
      })
      assert.ok(intentSeq < resultSeq, "intent seq must precede result seq")

      const records = readRecords(fp)
      assert.equal(records[0].phase, "intent")
      assert.equal(records[1].phase, "result")
      assert.equal(records[1].intentSeq, intentSeq)
    } finally {
      cleanup(dir)
    }
  })

  await test("AU-02: Tamper detection — modified record breaks chain", async () => {
    const dir = makeTempDir()
    const fp = join(dir, "audit.jsonl")
    try {
      const trail = new AuditTrail(fp)
      trail.setRunContext(CTX)
      await trail.recordIntent(INPUT)
      await trail.recordIntent({ ...INPUT, action: "get_issue" })

      // Tamper: modify the first record's action field
      const lines = readFileSync(fp, "utf-8").trim().split("\n")
      const record = JSON.parse(lines[0])
      record.action = "TAMPERED"
      lines[0] = JSON.stringify(record)
      writeFileSync(fp, lines.join("\n") + "\n", "utf-8")

      const result = await trail.verifyChain()
      assert.equal(result.valid, false, "chain should be invalid after tampering")
      assert.ok(result.errors.length > 0, "should report errors")
    } finally {
      cleanup(dir)
    }
  })

  await test("AU-03: Orphaned intent detection — intent without result", async () => {
    const dir = makeTempDir()
    const fp = join(dir, "audit.jsonl")
    try {
      const trail = new AuditTrail(fp)
      trail.setRunContext(CTX)
      const intentSeq = await trail.recordIntent(INPUT)

      // Verify chain is still valid (orphans don't break the hash chain)
      const chainResult = await trail.verifyChain()
      assert.ok(chainResult.valid, "chain should remain valid")

      // Manually verify: only intent, no matching result
      const records = readRecords(fp)
      const intents = records.filter((r) => r.phase === "intent")
      const results = records.filter((r) => r.phase === "result")
      assert.equal(intents.length, 1)
      assert.equal(results.length, 0, "no result record — orphaned intent")
      assert.equal(intents[0].seq, intentSeq)
    } finally {
      cleanup(dir)
    }
  })

  await test("AU-04: Rotation resets chain with fresh genesis", async () => {
    const dir = makeTempDir()
    const fp = join(dir, "audit.jsonl")
    try {
      const trail = new AuditTrail(fp)
      trail.setRunContext(CTX)
      await trail.recordIntent(INPUT)

      const rotatedPath = await trail.rotate()
      assert.ok(rotatedPath.includes("audit-"), "rotated file should be timestamped")

      // New record after rotation should start fresh
      await trail.recordIntent({ ...INPUT, action: "get_issue" })

      const newRecords = readRecords(fp)
      assert.equal(newRecords.length, 1)
      assert.equal(newRecords[0].seq, 1, "seq resets to 1 after rotation")
      assert.equal(newRecords[0].prevHash, "genesis", "prevHash is genesis after rotation")

      // New chain should verify cleanly
      const result = await trail.verifyChain()
      assert.ok(result.valid, "new chain should be valid")
    } finally {
      cleanup(dir)
    }
  })

  await test("AU-05: HMAC verification — records include hmac, chain verifies", async () => {
    const dir = makeTempDir()
    const fp = join(dir, "audit.jsonl")
    const hmacKey = Buffer.from("test-signing-key-32-bytes-long!!")
    try {
      const trail = new AuditTrail(fp, { hmacKey })
      trail.setRunContext(CTX)
      await trail.recordIntent(INPUT)
      await trail.recordIntent({ ...INPUT, action: "get_issue" })

      const records = readRecords(fp)
      for (const rec of records) {
        assert.ok(typeof rec.hmac === "string", "record should have hmac field")
        assert.ok((rec.hmac as string).length === 64, "hmac should be 64 hex chars")
      }

      const result = await trail.verifyChain()
      assert.ok(result.valid, "HMAC chain should verify cleanly")
    } finally {
      cleanup(dir)
    }
  })

  console.log("\nDone.")
}

main()
