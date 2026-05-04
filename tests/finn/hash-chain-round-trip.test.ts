// tests/finn/hash-chain-round-trip.test.ts — Hash chain property-based round-trip test (Task 3.8)
//
// Generates random records, writes via appendRecord methods, reads back, and verifies
// via verifyChain(). Covers legacy chain, bridge entry, protocol_v1 post-bridge records,
// state recovery, self-check, and file rotation.

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { AuditTrail } from "../../src/safety/audit-trail.js"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

let tmpDir: string
let trail: AuditTrail

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "audit-test-"))
  trail = new AuditTrail(join(tmpDir, "audit.jsonl"), {
    now: () => Date.now(),
  })
  trail.setRunContext({
    jobId: "test-job",
    runUlid: "test-ulid",
    templateId: "test-template",
  })
})

afterEach(async () => {
  await trail.shutdown()
  await rm(tmpDir, { recursive: true, force: true })
})

function randomAction(): string {
  const actions = ["create_issue", "update_pr", "merge", "comment", "label", "close", "reopen", "assign"]
  return actions[Math.floor(Math.random() * actions.length)]
}

function randomTarget(): string {
  const targets = ["issue/1", "pr/42", "repo/main", "branch/feature", "label/bug"]
  return targets[Math.floor(Math.random() * targets.length)]
}

function randomParams(): Record<string, unknown> {
  return {
    value: `value-${Math.floor(Math.random() * 1000)}`,
    count: Math.floor(Math.random() * 100),
    nested: { inner: Math.random().toString(36).slice(2) },
  }
}

describe("Hash Chain Round-Trip (Task 3.8)", () => {
  // ── Legacy chain round-trip ──────────────────────────────────

  describe("Legacy chain", () => {
    it("round-trips 100+ random records", async () => {
      for (let i = 0; i < 110; i++) {
        const phase = i % 3
        if (phase === 0) {
          await trail.recordIntent({
            action: randomAction(),
            target: randomTarget(),
            params: randomParams(),
          })
        } else if (phase === 1) {
          await trail.recordResult(Math.max(1, i), {
            action: randomAction(),
            target: randomTarget(),
            params: randomParams(),
            result: { status: "ok" },
          })
        } else {
          await trail.recordDenied({
            action: randomAction(),
            target: randomTarget(),
            params: randomParams(),
          })
        }
      }

      const verification = await trail.verifyChain()
      expect(verification.valid).toBe(true)
      expect(verification.errors).toHaveLength(0)
    })

    it("state recovery preserves chain integrity", async () => {
      // Write 50 records
      for (let i = 0; i < 50; i++) {
        await trail.recordIntent({
          action: randomAction(),
          target: randomTarget(),
          params: randomParams(),
        })
      }

      // Create new trail instance and recover
      const trail2 = new AuditTrail(join(tmpDir, "audit.jsonl"))
      trail2.setRunContext({
        jobId: "test-job-2",
        runUlid: "test-ulid-2",
        templateId: "test-template-2",
      })
      await trail2.recoverState()

      // Write more records on recovered trail
      for (let i = 0; i < 30; i++) {
        await trail2.recordIntent({
          action: randomAction(),
          target: randomTarget(),
          params: randomParams(),
        })
      }

      const verification = await trail2.verifyChain()
      expect(verification.valid).toBe(true)
      expect(verification.errors).toHaveLength(0)
      await trail2.shutdown()
    })

    it("HMAC-signed chain round-trips", async () => {
      const hmacKey = Buffer.from("test-signing-key-for-audit")
      const signedTrail = new AuditTrail(join(tmpDir, "signed-audit.jsonl"), {
        hmacKey,
        now: () => Date.now(),
      })
      signedTrail.setRunContext({
        jobId: "test-job",
        runUlid: "test-ulid",
        templateId: "test-template",
      })

      for (let i = 0; i < 50; i++) {
        await signedTrail.recordIntent({
          action: randomAction(),
          target: randomTarget(),
          params: randomParams(),
        })
      }

      const verification = await signedTrail.verifyChain()
      expect(verification.valid).toBe(true)
      await signedTrail.shutdown()
    })
  })

  // ── Bridge entry ─────────────────────────────────────────────

  describe("Bridge entry", () => {
    it("bridge entry links legacy to protocol chain", async () => {
      // Write legacy records first
      for (let i = 0; i < 10; i++) {
        await trail.recordIntent({
          action: randomAction(),
          target: randomTarget(),
          params: randomParams(),
        })
      }

      // Bridge
      const bridgeEntry = await trail.appendBridgeEntry()
      expect(bridgeEntry.format).toBe("bridge")
      expect(bridgeEntry.version).toBe(1)
      expect(typeof bridgeEntry.legacy_chain_tip).toBe("string")
      expect(typeof bridgeEntry.bridge_hash).toBe("string")

      // Verify chain with bridge
      const verification = await trail.verifyChain()
      expect(verification.valid).toBe(true)
      expect(verification.errors).toHaveLength(0)
    })

    it("cannot bridge twice", async () => {
      await trail.recordIntent({
        action: "test",
        target: "test",
        params: {},
      })
      await trail.appendBridgeEntry()

      await expect(trail.appendBridgeEntry()).rejects.toThrow("already exists")
    })
  })

  // ── Protocol chain (post-bridge) ─────────────────────────────

  describe("Protocol chain (post-bridge)", () => {
    it("writes protocol_v1 records after bridge", async () => {
      // Legacy records
      for (let i = 0; i < 5; i++) {
        await trail.recordIntent({
          action: randomAction(),
          target: randomTarget(),
          params: randomParams(),
        })
      }

      // Bridge
      await trail.appendBridgeEntry()

      // Protocol records (automatically protocol_v1 format since migrated=true)
      for (let i = 0; i < 20; i++) {
        await trail.recordIntent({
          action: randomAction(),
          target: randomTarget(),
          params: randomParams(),
        })
      }

      const verification = await trail.verifyChain()
      expect(verification.valid).toBe(true)
      expect(verification.errors).toHaveLength(0)
    })

    it("mixed record types (intent + result + denied + dry_run) post-bridge", async () => {
      await trail.recordIntent({ action: "pre", target: "pre", params: {} })
      await trail.appendBridgeEntry()

      // Mix of record types
      const intentSeq = await trail.recordIntent({
        action: "create_issue",
        target: "issue/1",
        params: { title: "test" },
      })
      await trail.recordResult(intentSeq, {
        action: "create_issue",
        target: "issue/1",
        params: { title: "test" },
        result: { id: 1 },
      })
      await trail.recordDenied({
        action: "delete_repo",
        target: "repo/main",
        params: {},
      })
      await trail.recordDryRun({
        action: "merge_pr",
        target: "pr/42",
        params: {},
        dryRun: true,
      })

      const verification = await trail.verifyChain()
      expect(verification.valid).toBe(true)
    })
  })

  // ── Migration state recovery (Task 3.6 integration) ──────────

  describe("Migration state recovery", () => {
    it("reconstructStateFromLog recovers after bridge + dual-write", async () => {
      // Write legacy + bridge + protocol
      for (let i = 0; i < 5; i++) {
        await trail.recordIntent({ action: "pre", target: "t", params: {} })
      }
      await trail.appendBridgeEntry()
      for (let i = 0; i < 10; i++) {
        await trail.recordIntent({ action: "post", target: "t", params: {} })
      }

      // Create new trail and reconstruct
      const trail2 = new AuditTrail(join(tmpDir, "audit.jsonl"))
      trail2.setRunContext({
        jobId: "recovered",
        runUlid: "recovered",
        templateId: "recovered",
      })
      await trail2.reconstructStateFromLog()

      // Write more records on recovered trail
      for (let i = 0; i < 5; i++) {
        await trail2.recordIntent({ action: "continued", target: "t", params: {} })
      }

      const verification = await trail2.verifyChain()
      expect(verification.valid).toBe(true)
      await trail2.shutdown()
    })

    it("fresh log gives clean state", async () => {
      const trail2 = new AuditTrail(join(tmpDir, "fresh.jsonl"))
      await trail2.reconstructStateFromLog()

      trail2.setRunContext({ jobId: "j", runUlid: "u", templateId: "t" })
      await trail2.recordIntent({ action: "first", target: "t", params: {} })

      const verification = await trail2.verifyChain()
      expect(verification.valid).toBe(true)
      await trail2.shutdown()
    })
  })

  // ── Self-check integration ───────────────────────────────────

  describe("Self-check", () => {
    it("selfCheck passes on fresh trail", async () => {
      const passed = await trail.selfCheck()
      expect(passed).toBe(true)
    })

    it("selfCheck passes after many records", async () => {
      for (let i = 0; i < 30; i++) {
        await trail.recordIntent({
          action: randomAction(),
          target: randomTarget(),
          params: randomParams(),
        })
      }
      const passed = await trail.selfCheck()
      expect(passed).toBe(true)
    })
  })

  // ── File rotation ────────────────────────────────────────────

  describe("File rotation", () => {
    it("rotation resets chain and new records verify", async () => {
      for (let i = 0; i < 10; i++) {
        await trail.recordIntent({
          action: randomAction(),
          target: randomTarget(),
          params: randomParams(),
        })
      }

      await trail.rotate()

      // Write new records after rotation
      for (let i = 0; i < 10; i++) {
        await trail.recordIntent({
          action: randomAction(),
          target: randomTarget(),
          params: randomParams(),
        })
      }

      const verification = await trail.verifyChain()
      expect(verification.valid).toBe(true)
    })
  })
})
