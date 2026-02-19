// tests/finn/sprint-11-hardening.test.ts — Sprint 11: Security & Infrastructure Hardening
//
// Tests for: WAL fencing token monotonicity (11.3), CreditNote BigInt (11.4),
// Onboarding personality null-check (11.5).
// Tasks 11.1/11.2 are Terraform-only (validated via terraform validate).

import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Task 11.3: WAL Fencing Token Monotonicity Validation
// ---------------------------------------------------------------------------

describe("WAL Fencing Token Monotonicity (Task 11.3)", async () => {
  const { WALWriterLock } = await import("../../src/billing/wal-writer-lock.js")

  function createMockRedis(evalResults: Record<string, unknown> = {}) {
    const store: Record<string, string> = {}
    let evalCallCount = 0

    return {
      store,
      evalCallCount: () => evalCallCount,
      eval: vi.fn(async (script: string, keys: string[], args: string[]) => {
        evalCallCount++
        const scriptStr = String(script)

        // Lock acquisition script (SETNX + INCR)
        if (scriptStr.includes("NX") && scriptStr.includes("INCR")) {
          const lockKey = keys[0]
          const fenceKey = keys[1]
          if (!store[lockKey]) {
            store[lockKey] = args[0]
            const current = Number(store[fenceKey] ?? "0") + 1
            store[fenceKey] = String(current)
            return [1, current]
          }
          return [0, store[lockKey]]
        }

        // CAS fencing script
        if (scriptStr.includes("CORRUPT") && scriptStr.includes("STALE")) {
          const key = keys[0]
          const incoming = args[0]
          const storedStr = store[key]

          if (!storedStr) {
            store[key] = incoming
            return "OK"
          }

          const stored = Number(storedStr)
          if (isNaN(stored) || stored < 0 || stored > 9007199254740991) {
            return "CORRUPT"
          }

          if (Number(incoming) > stored) {
            store[key] = incoming
            return "OK"
          }

          return "STALE"
        }

        // Keepalive/release scripts
        if (scriptStr.includes("EXPIRE") || scriptStr.includes("DEL")) {
          return 1
        }

        return evalResults[scriptStr] ?? null
      }),
      set: vi.fn(async () => "OK"),
      get: vi.fn(async (key: string) => store[key] ?? null),
      del: vi.fn(async () => 1),
      expire: vi.fn(async () => 1),
      incrby: vi.fn(async () => 1),
    }
  }

  it("fresh token accepted (CAS returns OK)", async () => {
    const redis = createMockRedis()
    const lock = new WALWriterLock({
      redis: redis as any,
      instanceId: "instance-1",
      environment: "test",
    })

    // Acquire lock first
    const acq = await lock.acquire()
    expect(acq.acquired).toBe(true)
    expect(acq.fencingToken).toBeGreaterThan(0)

    // Validate and advance — should succeed
    const result = await lock.validateAndAdvanceFencingToken(acq.fencingToken!)
    expect(result).toBe("OK")
  })

  it("stale token rejected (CAS returns STALE)", async () => {
    const redis = createMockRedis()
    const lock = new WALWriterLock({
      redis: redis as any,
      instanceId: "instance-1",
      environment: "test",
    })

    const acq = await lock.acquire()
    expect(acq.acquired).toBe(true)

    // Advance to token 5
    await lock.validateAndAdvanceFencingToken(5)

    // Now try with a lower token — should be STALE
    const result = await lock.validateAndAdvanceFencingToken(3)
    expect(result).toBe("STALE")
  })

  it("equal token rejected (must be strictly greater)", async () => {
    const redis = createMockRedis()
    const lock = new WALWriterLock({
      redis: redis as any,
      instanceId: "instance-1",
      environment: "test",
    })

    const acq = await lock.acquire()
    expect(acq.acquired).toBe(true)

    // Advance to token 5
    await lock.validateAndAdvanceFencingToken(5)

    // Same token should be STALE (must be strictly greater)
    const result = await lock.validateAndAdvanceFencingToken(5)
    expect(result).toBe("STALE")
  })

  it("corrupt stored token returns CORRUPT (non-numeric)", async () => {
    const redis = createMockRedis()
    // Manually corrupt the stored token
    redis.store["wal:writer:last_accepted:test"] = "abc"

    const lock = new WALWriterLock({
      redis: redis as any,
      instanceId: "instance-1",
      environment: "test",
    })

    // Force holder state
    const acq = await lock.acquire()
    expect(acq.acquired).toBe(true)

    const result = await lock.validateAndAdvanceFencingToken(10)
    expect(result).toBe("CORRUPT")
  })

  it("corrupt stored token returns CORRUPT (exceeds 2^53-1)", async () => {
    const redis = createMockRedis()
    redis.store["wal:writer:last_accepted:test"] = "9007199254740993"

    const lock = new WALWriterLock({
      redis: redis as any,
      instanceId: "instance-1",
      environment: "test",
    })

    const acq = await lock.acquire()
    expect(acq.acquired).toBe(true)

    const result = await lock.validateAndAdvanceFencingToken(10)
    expect(result).toBe("CORRUPT")
  })

  it("token exceeding MAX_SAFE_INTEGER rejected at issuance", async () => {
    const redis = createMockRedis()
    // Set fence to MAX_SAFE_INTEGER so next INCR overflows
    redis.store["wal:writer:fence"] = "9007199254740991"

    const lock = new WALWriterLock({
      redis: redis as any,
      instanceId: "instance-1",
      environment: "test",
    })

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const acq = await lock.acquire()

    // INCR returns 9007199254740992 which is NOT a safe integer
    expect(acq.acquired).toBe(false)
    expect(acq.fencingToken).toBeNull()
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("wal.fencing_token.overflow"),
    )
    consoleSpy.mockRestore()
  })

  it("non-holder returns STALE without calling Redis", async () => {
    const redis = createMockRedis()
    const lock = new WALWriterLock({
      redis: redis as any,
      instanceId: "instance-1",
      environment: "test",
    })

    // Don't acquire — not a holder
    const result = await lock.validateAndAdvanceFencingToken(5)
    expect(result).toBe("STALE")
    // CAS script should not have been called
    expect(redis.eval).not.toHaveBeenCalled()
  })

  it("negative token rejected as CORRUPT at input validation", async () => {
    const redis = createMockRedis()
    const lock = new WALWriterLock({
      redis: redis as any,
      instanceId: "instance-1",
      environment: "test",
    })

    const acq = await lock.acquire()
    expect(acq.acquired).toBe(true)

    const result = await lock.validateAndAdvanceFencingToken(-1)
    expect(result).toBe("CORRUPT")
  })

  it("per-environment key namespace isolation", async () => {
    // Use separate redis mocks to simulate independent environments
    const redisProd = createMockRedis()
    const redisStaging = createMockRedis()

    const lockProd = new WALWriterLock({
      redis: redisProd as any,
      instanceId: "instance-1",
      environment: "production",
    })
    const lockStaging = new WALWriterLock({
      redis: redisStaging as any,
      instanceId: "instance-2",
      environment: "staging",
    })

    await lockProd.acquire()
    await lockStaging.acquire()

    await lockProd.validateAndAdvanceFencingToken(10)
    await lockStaging.validateAndAdvanceFencingToken(20)

    // Each environment writes to its own namespaced key
    expect(redisProd.store["wal:writer:last_accepted:production"]).toBe("10")
    expect(redisStaging.store["wal:writer:last_accepted:staging"]).toBe("20")

    // Cross-check: prod doesn't have staging key and vice versa
    expect(redisProd.store["wal:writer:last_accepted:staging"]).toBeUndefined()
    expect(redisStaging.store["wal:writer:last_accepted:production"]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Task 11.4: CreditNote BigInt Consistency Fix
// ---------------------------------------------------------------------------

describe("CreditNote BigInt Consistency (Task 11.4)", async () => {
  const { CreditNoteService } = await import("../../src/x402/credit-note.js")

  function createMockRedis() {
    const store: Record<string, string> = {}

    return {
      set: vi.fn(async () => "OK"),
      get: vi.fn(async (key: string) => store[key] ?? null),
      del: vi.fn(async () => 1),
      expire: vi.fn(async () => 1),
      incrby: vi.fn(async (key: string, value: number) => {
        const current = Number(store[key] ?? "0")
        const newVal = current + value
        store[key] = String(newVal)
        return newVal
      }),
      eval: vi.fn(async (_script: string, keys: string[], args: string[]) => {
        const key = Array.isArray(keys) ? keys[0] : keys
        const delta = Number(args[0])
        const cap = Number(args[1])
        const ttl = Number(args[2])
        const current = Number(store[key as string] ?? "0")

        if (current + delta > cap) {
          return "CAP_EXCEEDED"
        }

        const newBalance = current + delta
        store[key as string] = String(newBalance)
        return String(newBalance)
      }),
      store,
    }
  }

  it("issues credit note with normal delta", async () => {
    const redis = createMockRedis()
    const service = new CreditNoteService({ redis: redis as any })

    const note = await service.issueCreditNote(
      "0xABC",
      "quote_1",
      "10000000", // 10 USDC quoted
      "5000000",  // 5 USDC actual
    )

    expect(note).not.toBeNull()
    expect(note!.amount).toBe("5000000") // 5 USDC delta
    // Verify Lua was called (not raw incrby)
    expect(redis.eval).toHaveBeenCalled()
  })

  it("multiple sequential issuances accumulate correctly", async () => {
    const redis = createMockRedis()
    const service = new CreditNoteService({ redis: redis as any })

    await service.issueCreditNote("0xABC", "q1", "10000000", "8000000") // 2 USDC delta
    await service.issueCreditNote("0xABC", "q2", "10000000", "7000000") // 3 USDC delta

    // Balance should be 5_000_000 (2 + 3 USDC)
    const balanceKey = "x402:credit:0xabc:balance"
    expect(redis.store[balanceKey]).toBe("5000000")
  })

  it("rejects delta exceeding Number.MAX_SAFE_INTEGER", async () => {
    const redis = createMockRedis()
    const service = new CreditNoteService({ redis: redis as any })

    // Use values where quoted - actual > MAX_SAFE_INTEGER
    await expect(
      service.issueCreditNote(
        "0xABC",
        "q1",
        "99007199254740992", // Just above MAX_SAFE_INTEGER
        "0",
      ),
    ).rejects.toThrow("CreditNote delta exceeds safe integer range")
  })

  it("rejects balance exceeding MAX_CREDIT_BALANCE (CAP_EXCEEDED)", async () => {
    const redis = createMockRedis()
    // Pre-set balance near cap
    redis.store["x402:credit:0xabc:balance"] = "999999999999" // 999,999.999999 USDC

    const service = new CreditNoteService({ redis: redis as any })

    // This delta would push balance over 1M USDC cap
    await expect(
      service.issueCreditNote(
        "0xABC",
        "q1",
        "2000000", // 2 USDC quoted
        "0",        // 0 actual → 2 USDC delta
      ),
    ).rejects.toThrow("credit_note_cap_exceeded")
  })

  it("no credit note issued when actual >= quoted", async () => {
    const redis = createMockRedis()
    const service = new CreditNoteService({ redis: redis as any })

    const note = await service.issueCreditNote("0xABC", "q1", "5000000", "5000000")
    expect(note).toBeNull()
    expect(redis.eval).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Task 11.5: Onboarding Personality Null-Check Fix
// ---------------------------------------------------------------------------

describe("Onboarding Personality Null-Check (Task 11.5)", async () => {
  const { OnboardingService } = await import("../../src/nft/onboarding.js")

  function createMockDeps(personalityExists: boolean) {
    const created: any[] = []
    const updated: any[] = []

    return {
      created,
      updated,
      deps: {
        redis: {
          set: vi.fn(async () => "OK"),
          get: vi.fn(async () => JSON.stringify({
            session_id: "test-session",
            wallet_address: "0xabc",
            current_step: "personality_config",
            step_index: 3,
            completed_steps: ["wallet_connect", "nft_detect", "nft_select"],
            selected_nft: { collection: "0xcol", token_id: "42" },
            personality_configured: false,
            credits_purchased: false,
            created_at: Date.now(),
            updated_at: Date.now(),
          })),
          expire: vi.fn(async () => 1),
          del: vi.fn(async () => 1),
        },
        ownershipService: {
          verifyOwnership: vi.fn(async () => true),
        },
        personalityService: {
          get: vi.fn(async () => personalityExists ? { name: "Existing", voice: "analytical" } : null),
          create: vi.fn(async (...args: any[]) => { created.push(args); return {} }),
          update: vi.fn(async (...args: any[]) => { updated.push(args); return {} }),
        },
        allowlistService: {
          isAllowed: vi.fn(async () => true),
        },
        featureFlagService: {
          isEnabled: vi.fn(async () => true),
        },
      },
    }
  }

  it("creates personality via null-check when none exists", async () => {
    const { deps, created, updated } = createMockDeps(false)
    const service = new OnboardingService(deps as any)

    const state = await service.configurePersonality("test-session", {
      voice: "creative",
      expertise_domains: ["DeFi"],
      custom_instructions: "Be friendly",
    })

    expect(state.personality_configured).toBe(true)
    expect(created.length).toBe(1)
    expect(updated.length).toBe(0)
    // Verify create was called with correct params
    expect(deps.personalityService.create).toHaveBeenCalledWith(
      "0xcol", "42",
      expect.objectContaining({ voice: "creative" }),
    )
  })

  it("updates personality via null-check when one exists", async () => {
    const { deps, created, updated } = createMockDeps(true)
    const service = new OnboardingService(deps as any)

    const state = await service.configurePersonality("test-session", {
      voice: "witty",
    })

    expect(state.personality_configured).toBe(true)
    expect(created.length).toBe(0)
    expect(updated.length).toBe(1)
    expect(deps.personalityService.update).toHaveBeenCalledWith(
      "0xcol", "42",
      expect.objectContaining({ voice: "witty" }),
    )
  })

  it("no exception thrown during normal null-check flow", async () => {
    const { deps } = createMockDeps(false)
    const service = new OnboardingService(deps as any)

    // Should not throw — null check, not try/catch
    await expect(
      service.configurePersonality("test-session", { voice: "sage" }),
    ).resolves.toBeDefined()

    // Verify get() was called (null-check path, not exception path)
    expect(deps.personalityService.get).toHaveBeenCalledWith("0xcol", "42")
  })
})
