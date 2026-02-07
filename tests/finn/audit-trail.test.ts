// tests/finn/audit-trail.test.ts — Write-Ahead Audit Trail tests (SDD §4.3)

import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { AuditTrail } from "../../src/safety/audit-trail.js"

// ── Helpers ──────────────────────────────────────────────────

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

/** Create a temp directory for test isolation. */
async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "audit-trail-test-"))
}

// ── Tests ────────────────────────────────────────────────────

async function main() {
  console.log("Audit Trail Tests")
  console.log("==================")

  // ── 1. Hash Chain Integrity ─────────────────────────────

  console.log("\n--- Hash Chain Integrity ---")

  await test("record 3 entries and verify chain", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "audit.jsonl")
    const trail = new AuditTrail(filePath)
    trail.setRunContext({ jobId: "job-1", runUlid: "ulid-1", templateId: "tpl-1" })

    await trail.recordIntent({ action: "create_issue", target: "org/repo#1", params: { title: "Test" } })
    await trail.recordIntent({ action: "add_comment", target: "org/repo#2", params: { body: "Hi" } })
    await trail.recordDenied({ action: "delete_branch", target: "org/repo/main", params: {} })

    const result = await trail.verifyChain()
    assert.equal(result.valid, true, `Chain errors: ${result.errors.join("; ")}`)
    assert.equal(result.errors.length, 0)

    // Verify the file has 3 lines
    const content = await readFile(filePath, "utf-8")
    const lines = content.trim().split("\n")
    assert.equal(lines.length, 3)

    // Verify seq numbers are sequential
    const records = lines.map((l) => JSON.parse(l))
    assert.equal(records[0].seq, 1)
    assert.equal(records[1].seq, 2)
    assert.equal(records[2].seq, 3)

    // Verify genesis linkage
    assert.equal(records[0].prevHash, "genesis")
    // Verify chain linkage
    assert.equal(records[1].prevHash, records[0].hash)
    assert.equal(records[2].prevHash, records[1].hash)

    await rm(dir, { recursive: true })
  })

  // ── 2. Tamper Detection ─────────────────────────────────

  console.log("\n--- Tamper Detection ---")

  await test("tampered record causes verifyChain failure", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "audit.jsonl")
    const trail = new AuditTrail(filePath)
    trail.setRunContext({ jobId: "job-1", runUlid: "ulid-1", templateId: "tpl-1" })

    await trail.recordIntent({ action: "create_issue", target: "org/repo#1", params: { title: "Test" } })
    await trail.recordIntent({ action: "add_comment", target: "org/repo#2", params: { body: "Hi" } })

    // Tamper with the first record
    const content = await readFile(filePath, "utf-8")
    const lines = content.trim().split("\n")
    const record = JSON.parse(lines[0])
    record.action = "TAMPERED"
    lines[0] = JSON.stringify(record)
    await writeFile(filePath, lines.join("\n") + "\n", "utf-8")

    const result = await trail.verifyChain()
    assert.equal(result.valid, false)
    assert.ok(result.errors.length > 0)
    assert.ok(result.errors.some((e) => e.includes("hash mismatch")))

    await rm(dir, { recursive: true })
  })

  await test("broken chain linkage detected", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "audit.jsonl")
    const trail = new AuditTrail(filePath)
    trail.setRunContext({ jobId: "job-1", runUlid: "ulid-1", templateId: "tpl-1" })

    await trail.recordIntent({ action: "a", target: "t", params: {} })
    await trail.recordIntent({ action: "b", target: "t", params: {} })
    await trail.recordIntent({ action: "c", target: "t", params: {} })

    // Swap lines 1 and 2 to break chain linkage
    const content = await readFile(filePath, "utf-8")
    const lines = content.trim().split("\n")
    const tmp = lines[1]
    lines[1] = lines[2]
    lines[2] = tmp
    await writeFile(filePath, lines.join("\n") + "\n", "utf-8")

    const result = await trail.verifyChain()
    assert.equal(result.valid, false)
    assert.ok(result.errors.some((e) => e.includes("prevHash mismatch")))

    await rm(dir, { recursive: true })
  })

  // ── 3. Intent-Result Pairing ────────────────────────────

  console.log("\n--- Intent-Result Pairing ---")

  await test("intentSeq links result to intent", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "audit.jsonl")
    const trail = new AuditTrail(filePath)
    trail.setRunContext({ jobId: "job-1", runUlid: "ulid-1", templateId: "tpl-1" })

    const intentSeq = await trail.recordIntent({
      action: "create_issue",
      target: "org/repo",
      params: { title: "New issue" },
    })

    const resultSeq = await trail.recordResult(intentSeq, {
      action: "create_issue",
      target: "org/repo",
      params: { title: "New issue" },
      result: { number: 42, url: "https://github.com/org/repo/issues/42" },
    })

    assert.equal(intentSeq, 1)
    assert.equal(resultSeq, 2)

    const content = await readFile(filePath, "utf-8")
    const lines = content.trim().split("\n")
    const intentRecord = JSON.parse(lines[0])
    const resultRecord = JSON.parse(lines[1])

    assert.equal(intentRecord.phase, "intent")
    assert.equal(resultRecord.phase, "result")
    assert.equal(resultRecord.intentSeq, intentSeq)
    assert.equal(intentRecord.intentSeq, undefined)

    // Chain should still verify
    const verify = await trail.verifyChain()
    assert.equal(verify.valid, true, `Chain errors: ${verify.errors.join("; ")}`)

    await rm(dir, { recursive: true })
  })

  await test("result record includes result and error fields", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "audit.jsonl")
    const trail = new AuditTrail(filePath)
    trail.setRunContext({ jobId: "job-1", runUlid: "ulid-1", templateId: "tpl-1" })

    const intentSeq = await trail.recordIntent({
      action: "push_files",
      target: "org/repo",
      params: { branch: "finn/test" },
    })

    await trail.recordResult(intentSeq, {
      action: "push_files",
      target: "org/repo",
      params: { branch: "finn/test" },
      error: "rate limit exceeded",
      rateLimitRemaining: 0,
    })

    const content = await readFile(filePath, "utf-8")
    const resultRecord = JSON.parse(content.trim().split("\n")[1])
    assert.equal(resultRecord.error, "rate limit exceeded")
    assert.equal(resultRecord.rateLimitRemaining, 0)

    await rm(dir, { recursive: true })
  })

  // ── 4. Secret Redaction ─────────────────────────────────

  console.log("\n--- Secret Redaction ---")

  await test("gh token in params gets redacted", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "audit.jsonl")
    const trail = new AuditTrail(filePath)
    trail.setRunContext({ jobId: "job-1", runUlid: "ulid-1", templateId: "tpl-1" })

    await trail.recordIntent({
      action: "create_issue",
      target: "org/repo",
      params: {
        title: "Test",
        auth: "ghp_1234567890abcdef",
        token: "some-value",
        apiSecret: "s3cr3t",
        password: "hunter2",
        normal: "not-a-secret",
      },
    })

    const content = await readFile(filePath, "utf-8")
    const record = JSON.parse(content.trim())

    // Values matching secret patterns should be redacted
    assert.equal(record.params.auth, "[REDACTED]")
    assert.equal(record.params.token, "[REDACTED]")
    assert.equal(record.params.apiSecret, "[REDACTED]")
    assert.equal(record.params.password, "[REDACTED]")
    // Normal values should be preserved
    assert.equal(record.params.normal, "not-a-secret")
    assert.equal(record.params.title, "Test")

    await rm(dir, { recursive: true })
  })

  await test("Bearer token in value gets redacted", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "audit.jsonl")
    const trail = new AuditTrail(filePath)
    trail.setRunContext({ jobId: "job-1", runUlid: "ulid-1", templateId: "tpl-1" })

    await trail.recordIntent({
      action: "webhook",
      target: "api.example.com",
      params: {
        authorization: "Bearer eyJhbGciOi...",
        data: "safe-value",
      },
    })

    const content = await readFile(filePath, "utf-8")
    const record = JSON.parse(content.trim())
    assert.equal(record.params.authorization, "[REDACTED]")
    assert.equal(record.params.data, "safe-value")

    await rm(dir, { recursive: true })
  })

  await test("ghs_ and gho_ tokens get redacted", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "audit.jsonl")
    const trail = new AuditTrail(filePath)
    trail.setRunContext({ jobId: "job-1", runUlid: "ulid-1", templateId: "tpl-1" })

    await trail.recordIntent({
      action: "auth",
      target: "github.com",
      params: {
        installToken: "ghs_abc123",
        oauthCode: "gho_xyz789",
      },
    })

    const content = await readFile(filePath, "utf-8")
    const record = JSON.parse(content.trim())
    assert.equal(record.params.installToken, "[REDACTED]")
    assert.equal(record.params.oauthCode, "[REDACTED]")

    await rm(dir, { recursive: true })
  })

  await test("array containing secrets gets redacted (H-1)", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "audit.jsonl")
    const trail = new AuditTrail(filePath)
    trail.setRunContext({ jobId: "job-1", runUlid: "ulid-1", templateId: "tpl-1" })

    await trail.recordIntent({
      action: "multi_auth",
      target: "api.example.com",
      params: {
        // Key "values" is NOT a secret key pattern, so only ghp_ prefixed items get redacted
        values: ["ghp_secret1", "ghp_secret2", "normal-value"],
        names: ["alice", "bob"],
        nested: [{ token: "inner-secret", name: "safe" }],
      },
    })

    const content = await readFile(filePath, "utf-8")
    const record = JSON.parse(content.trim())

    // String items matching secret VALUE patterns (ghp_ prefix) should be redacted
    const values = record.params.values as string[]
    assert.equal(values[0], "[REDACTED]")
    assert.equal(values[1], "[REDACTED]")
    assert.equal(values[2], "normal-value")

    // Non-secret string arrays should be preserved
    const names = record.params.names as string[]
    assert.equal(names[0], "alice")
    assert.equal(names[1], "bob")

    // Objects within arrays should have their secrets redacted
    const nested = record.params.nested as Array<Record<string, unknown>>
    assert.equal(nested[0].token, "[REDACTED]")
    assert.equal(nested[0].name, "safe")

    await rm(dir, { recursive: true })
  })

  await test("nested secret params get redacted", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "audit.jsonl")
    const trail = new AuditTrail(filePath)
    trail.setRunContext({ jobId: "job-1", runUlid: "ulid-1", templateId: "tpl-1" })

    await trail.recordIntent({
      action: "nested",
      target: "test",
      params: {
        config: {
          token: "should-be-redacted",
          name: "safe-value",
        },
      },
    })

    const content = await readFile(filePath, "utf-8")
    const record = JSON.parse(content.trim())
    assert.equal((record.params.config as Record<string, unknown>).token, "[REDACTED]")
    assert.equal((record.params.config as Record<string, unknown>).name, "safe-value")

    await rm(dir, { recursive: true })
  })

  // ── 5. HMAC Signing ─────────────────────────────────────

  console.log("\n--- HMAC Signing ---")

  await test("HMAC is computed when hmacKey is provided", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "audit.jsonl")
    const hmacKey = Buffer.from("test-signing-key")
    const trail = new AuditTrail(filePath, { hmacKey })
    trail.setRunContext({ jobId: "job-1", runUlid: "ulid-1", templateId: "tpl-1" })

    await trail.recordIntent({
      action: "create_issue",
      target: "org/repo",
      params: { title: "Signed" },
    })

    const content = await readFile(filePath, "utf-8")
    const record = JSON.parse(content.trim())

    assert.ok(record.hmac, "hmac field should be present")
    assert.equal(typeof record.hmac, "string")
    assert.equal(record.hmac.length, 64, "HMAC-SHA256 hex should be 64 chars")

    // Verify chain should pass
    const verify = await trail.verifyChain()
    assert.equal(verify.valid, true, `Chain errors: ${verify.errors.join("; ")}`)

    await rm(dir, { recursive: true })
  })

  await test("HMAC is absent when no hmacKey is provided", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "audit.jsonl")
    const trail = new AuditTrail(filePath)
    trail.setRunContext({ jobId: "job-1", runUlid: "ulid-1", templateId: "tpl-1" })

    await trail.recordIntent({
      action: "create_issue",
      target: "org/repo",
      params: { title: "Unsigned" },
    })

    const content = await readFile(filePath, "utf-8")
    const record = JSON.parse(content.trim())
    assert.equal(record.hmac, undefined)

    await rm(dir, { recursive: true })
  })

  // ── 6. Recovery from Existing File ──────────────────────

  console.log("\n--- Recovery from Existing File ---")

  await test("recoverState picks up seq and hash from existing file", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "audit.jsonl")

    // Write initial records with first trail instance
    const trail1 = new AuditTrail(filePath)
    trail1.setRunContext({ jobId: "job-1", runUlid: "ulid-1", templateId: "tpl-1" })
    await trail1.recordIntent({ action: "a", target: "t", params: {} })
    await trail1.recordIntent({ action: "b", target: "t", params: {} })

    // Create a new trail instance and recover state
    const trail2 = new AuditTrail(filePath)
    trail2.setRunContext({ jobId: "job-1", runUlid: "ulid-1", templateId: "tpl-1" })
    await trail2.recoverState()

    // Append a third record — should continue the chain
    await trail2.recordIntent({ action: "c", target: "t", params: {} })

    // Verify the whole chain is valid
    const result = await trail2.verifyChain()
    assert.equal(result.valid, true, `Chain errors: ${result.errors.join("; ")}`)

    // Check that seq continued correctly
    const content = await readFile(filePath, "utf-8")
    const lines = content.trim().split("\n")
    assert.equal(lines.length, 3)
    const lastRecord = JSON.parse(lines[2])
    assert.equal(lastRecord.seq, 3)

    // Verify hash linkage across trail instances
    const secondRecord = JSON.parse(lines[1])
    assert.equal(lastRecord.prevHash, secondRecord.hash)

    await rm(dir, { recursive: true })
  })

  await test("recoverState on non-existent file starts fresh", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "does-not-exist.jsonl")

    const trail = new AuditTrail(filePath)
    // Should not throw
    await trail.recoverState()

    trail.setRunContext({ jobId: "job-1", runUlid: "ulid-1", templateId: "tpl-1" })
    await trail.recordIntent({ action: "first", target: "t", params: {} })

    const content = await readFile(filePath, "utf-8")
    const record = JSON.parse(content.trim())
    assert.equal(record.seq, 1)
    assert.equal(record.prevHash, "genesis")

    await rm(dir, { recursive: true })
  })

  // ── 7. Self-Check ───────────────────────────────────────

  console.log("\n--- Self-Check ---")

  await test("selfCheck passes on fresh file", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "audit.jsonl")
    const trail = new AuditTrail(filePath)

    const ok = await trail.selfCheck()
    assert.equal(ok, true)

    // Verify self-check record was written
    const content = await readFile(filePath, "utf-8")
    const record = JSON.parse(content.trim())
    assert.equal(record.action, "self_check")
    assert.equal(record.jobId, "_self_check")

    await rm(dir, { recursive: true })
  })

  await test("selfCheck passes on file with existing records", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "audit.jsonl")
    const trail = new AuditTrail(filePath)
    trail.setRunContext({ jobId: "job-1", runUlid: "ulid-1", templateId: "tpl-1" })

    await trail.recordIntent({ action: "a", target: "t", params: {} })
    await trail.recordIntent({ action: "b", target: "t", params: {} })

    const ok = await trail.selfCheck()
    assert.equal(ok, true)

    // Verify chain including self-check record
    const result = await trail.verifyChain()
    assert.equal(result.valid, true)

    await rm(dir, { recursive: true })
  })

  // ── 8. File Rotation ────────────────────────────────────

  console.log("\n--- File Rotation ---")

  await test("shouldRotate returns false for small files", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "audit.jsonl")
    const trail = new AuditTrail(filePath)
    trail.setRunContext({ jobId: "job-1", runUlid: "ulid-1", templateId: "tpl-1" })

    await trail.recordIntent({ action: "a", target: "t", params: {} })

    const should = await trail.shouldRotate()
    assert.equal(should, false)

    await rm(dir, { recursive: true })
  })

  await test("shouldRotate returns true for files > 10MB", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "audit.jsonl")

    // Write a file larger than 10MB
    const bigLine = "x".repeat(1024) + "\n"
    const chunks: string[] = []
    // 10MB / 1025 bytes per line ~ 10240 lines, add a buffer
    for (let i = 0; i < 10500; i++) {
      chunks.push(bigLine)
    }
    await writeFile(filePath, chunks.join(""), "utf-8")

    const trail = new AuditTrail(filePath)
    const should = await trail.shouldRotate()
    assert.equal(should, true)

    await rm(dir, { recursive: true })
  })

  await test("shouldRotate returns false for non-existent file", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "no-such-file.jsonl")
    const trail = new AuditTrail(filePath)

    const should = await trail.shouldRotate()
    assert.equal(should, false)

    await rm(dir, { recursive: true })
  })

  await test("rotate renames file and resets chain state", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "audit.jsonl")
    const fixedNow = 1700000000000
    const trail = new AuditTrail(filePath, { now: () => fixedNow })
    trail.setRunContext({ jobId: "job-1", runUlid: "ulid-1", templateId: "tpl-1" })

    await trail.recordIntent({ action: "a", target: "t", params: {} })

    const rotatedPath = await trail.rotate()
    assert.ok(rotatedPath.includes("2023-11-14"), `Rotated path should contain date: ${rotatedPath}`)

    // After rotation, new records start from genesis
    await trail.recordIntent({ action: "after-rotation", target: "t", params: {} })

    const content = await readFile(filePath, "utf-8")
    const record = JSON.parse(content.trim())
    assert.equal(record.seq, 1)
    assert.equal(record.prevHash, "genesis")

    await rm(dir, { recursive: true })
  })

  // ── 9. Phase Records ────────────────────────────────────

  console.log("\n--- Phase Records ---")

  await test("recordDenied writes denied phase", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "audit.jsonl")
    const trail = new AuditTrail(filePath)
    trail.setRunContext({ jobId: "job-1", runUlid: "ulid-1", templateId: "tpl-1" })

    await trail.recordDenied({
      action: "merge_pull_request",
      target: "org/repo#5",
      params: { method: "squash" },
    })

    const content = await readFile(filePath, "utf-8")
    const record = JSON.parse(content.trim())
    assert.equal(record.phase, "denied")
    assert.equal(record.action, "merge_pull_request")

    await rm(dir, { recursive: true })
  })

  await test("recordDryRun writes dry_run phase with dryRun=true", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "audit.jsonl")
    const trail = new AuditTrail(filePath)
    trail.setRunContext({ jobId: "job-1", runUlid: "ulid-1", templateId: "tpl-1" })

    await trail.recordDryRun({
      action: "create_issue",
      target: "org/repo",
      params: { title: "Dry run test" },
      dryRun: true,
    })

    const content = await readFile(filePath, "utf-8")
    const record = JSON.parse(content.trim())
    assert.equal(record.phase, "dry_run")
    assert.equal(record.dryRun, true)

    await rm(dir, { recursive: true })
  })

  // ── 10. Run Context ─────────────────────────────────────

  console.log("\n--- Run Context ---")

  await test("run context is included in records", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "audit.jsonl")
    const trail = new AuditTrail(filePath)
    trail.setRunContext({ jobId: "job-42", runUlid: "01ARZ3NDEKTSV4RRFFQ69G5FAV", templateId: "tpl-review" })

    await trail.recordIntent({ action: "a", target: "t", params: {} })

    const content = await readFile(filePath, "utf-8")
    const record = JSON.parse(content.trim())
    assert.equal(record.jobId, "job-42")
    assert.equal(record.runUlid, "01ARZ3NDEKTSV4RRFFQ69G5FAV")
    assert.equal(record.templateId, "tpl-review")

    await rm(dir, { recursive: true })
  })

  await test("clearRunContext removes context from subsequent records", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "audit.jsonl")
    const trail = new AuditTrail(filePath)
    trail.setRunContext({ jobId: "job-1", runUlid: "ulid-1", templateId: "tpl-1" })

    await trail.recordIntent({ action: "a", target: "t", params: {} })
    trail.clearRunContext()
    await trail.recordIntent({ action: "b", target: "t", params: {} })

    const content = await readFile(filePath, "utf-8")
    const lines = content.trim().split("\n")
    const first = JSON.parse(lines[0])
    const second = JSON.parse(lines[1])

    assert.equal(first.jobId, "job-1")
    assert.equal(second.jobId, "")

    await rm(dir, { recursive: true })
  })

  // ── 11. Timestamp ───────────────────────────────────────

  console.log("\n--- Timestamp ---")

  await test("injectable clock controls timestamps", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "audit.jsonl")
    const fixedNow = 1700000000000 // 2023-11-14T22:13:20.000Z
    const trail = new AuditTrail(filePath, { now: () => fixedNow })
    trail.setRunContext({ jobId: "job-1", runUlid: "ulid-1", templateId: "tpl-1" })

    await trail.recordIntent({ action: "a", target: "t", params: {} })

    const content = await readFile(filePath, "utf-8")
    const record = JSON.parse(content.trim())
    assert.equal(record.ts, new Date(fixedNow).toISOString())

    await rm(dir, { recursive: true })
  })

  // ── 12. DedupeKey ───────────────────────────────────────

  console.log("\n--- DedupeKey ---")

  await test("dedupeKey is included in record when provided", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "audit.jsonl")
    const trail = new AuditTrail(filePath)
    trail.setRunContext({ jobId: "job-1", runUlid: "ulid-1", templateId: "tpl-1" })

    await trail.recordIntent({
      action: "add_comment",
      target: "org/repo#5",
      params: { body: "LGTM" },
      dedupeKey: "comment:org/repo#5:lgtm",
    })

    const content = await readFile(filePath, "utf-8")
    const record = JSON.parse(content.trim())
    assert.equal(record.dedupeKey, "comment:org/repo#5:lgtm")

    await rm(dir, { recursive: true })
  })

  console.log("\nDone.")
}

main()
