// tests/finn/access-policy-shadow.test.ts — Access Policy Shadow Evaluation (Sprint 2, Task 2.6)
//
// Tests the graduated rollout ladder: observe → asymmetric → enforce.
// Verifies divergence logging, error handling, and privilege escalation prevention.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  evaluateAccessPolicyShadow,
  ACCESS_POLICY_ENFORCEMENT_MODE,
  type AccessPolicyEnforcementMode,
} from "../../src/hounfour/pool-enforcement.js"
import type { JWTClaims } from "../../src/hounfour/jwt-auth.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClaims(overrides?: Partial<JWTClaims> & Record<string, unknown>): JWTClaims {
  return {
    iss: "https://arrakis.test",
    aud: "loa-finn",
    sub: "user-1",
    tenant_id: "tenant-1",
    tier: "pro" as JWTClaims["tier"],
    req_hash: "abc123",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  } as JWTClaims
}

/** Access policy that always allows */
const ALLOW_POLICY = {
  type: "read_only" as const,
  audit_required: false,
  revocable: false,
}

/** Access policy that always denies */
const DENY_POLICY = {
  type: "none" as const,
  audit_required: false,
  revocable: false,
}

// ---------------------------------------------------------------------------
// Default mode
// ---------------------------------------------------------------------------

describe("ACCESS_POLICY_ENFORCEMENT_MODE", () => {
  it("is a valid enforcement mode", () => {
    expect(["observe", "asymmetric", "enforce"]).toContain(ACCESS_POLICY_ENFORCEMENT_MODE)
  })
})

// ---------------------------------------------------------------------------
// No access_policy in claims — pass through
// ---------------------------------------------------------------------------

describe("evaluateAccessPolicyShadow — no access_policy", () => {
  it("returns localAllowed=true when no access_policy in claims", () => {
    const claims = makeClaims()
    expect(evaluateAccessPolicyShadow(claims, true)).toBe(true)
  })

  it("returns localAllowed=false when no access_policy in claims", () => {
    const claims = makeClaims()
    expect(evaluateAccessPolicyShadow(claims, false)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Observe mode — log only, local always wins
// ---------------------------------------------------------------------------

describe("evaluateAccessPolicyShadow — observe mode", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let infoSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    infoSpy.mockRestore()
  })

  it("local=true, protocol=allow → no divergence, returns true", () => {
    const claims = makeClaims({ access_policy: ALLOW_POLICY })
    const result = evaluateAccessPolicyShadow(claims, true, "observe")
    expect(result).toBe(true)
    // No divergence → no logging
    expect(warnSpy).not.toHaveBeenCalled()
    expect(infoSpy).not.toHaveBeenCalled()
  })

  it("local=true, protocol=deny → logs warn, returns true (local wins)", () => {
    const claims = makeClaims({ access_policy: DENY_POLICY })
    const result = evaluateAccessPolicyShadow(claims, true, "observe")
    expect(result).toBe(true) // local wins in observe
    expect(warnSpy).toHaveBeenCalledOnce()
    const logEntry = JSON.parse(warnSpy.mock.calls[0][1])
    expect(logEntry.event).toBe("access_policy_divergence")
    expect(logEntry.mode).toBe("observe")
    expect(logEntry.local_allowed).toBe(true)
    expect(logEntry.protocol_allowed).toBe(false)
    expect(logEntry.action_taken).toBe("local_wins")
  })

  it("local=false, protocol=allow → logs info, returns false (local wins)", () => {
    const claims = makeClaims({ access_policy: ALLOW_POLICY })
    const result = evaluateAccessPolicyShadow(claims, false, "observe")
    expect(result).toBe(false) // local wins in observe
    expect(infoSpy).toHaveBeenCalledOnce()
    const logEntry = JSON.parse(infoSpy.mock.calls[0][1])
    expect(logEntry.event).toBe("access_policy_divergence")
    expect(logEntry.action_taken).toBe("local_wins")
  })
})

// ---------------------------------------------------------------------------
// Asymmetric mode — protocol-deny overrides, protocol-allow does NOT
// ---------------------------------------------------------------------------

describe("evaluateAccessPolicyShadow — asymmetric mode", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let infoSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    infoSpy.mockRestore()
  })

  it("local=true, protocol=deny → returns false (protocol-deny overrides)", () => {
    const claims = makeClaims({ access_policy: DENY_POLICY })
    const result = evaluateAccessPolicyShadow(claims, true, "asymmetric")
    expect(result).toBe(false)
    expect(warnSpy).toHaveBeenCalledOnce()
    const logEntry = JSON.parse(warnSpy.mock.calls[0][1])
    expect(logEntry.action_taken).toBe("protocol_deny_wins")
  })

  it("local=false, protocol=allow → returns false (NO privilege escalation)", () => {
    const claims = makeClaims({ access_policy: ALLOW_POLICY })
    const result = evaluateAccessPolicyShadow(claims, false, "asymmetric")
    expect(result).toBe(false) // local-deny is NOT overridden
    expect(infoSpy).toHaveBeenCalledOnce()
    const logEntry = JSON.parse(infoSpy.mock.calls[0][1])
    expect(logEntry.action_taken).toBe("local_wins")
  })

  it("local=true, protocol=allow → no divergence, returns true", () => {
    const claims = makeClaims({ access_policy: ALLOW_POLICY })
    const result = evaluateAccessPolicyShadow(claims, true, "asymmetric")
    expect(result).toBe(true)
    expect(warnSpy).not.toHaveBeenCalled()
    expect(infoSpy).not.toHaveBeenCalled()
  })

  it("local=false, protocol=deny → no divergence, returns false", () => {
    const claims = makeClaims({ access_policy: DENY_POLICY })
    const result = evaluateAccessPolicyShadow(claims, false, "asymmetric")
    expect(result).toBe(false)
    expect(warnSpy).not.toHaveBeenCalled()
    expect(infoSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Enforce mode — protocol replaces local entirely
// ---------------------------------------------------------------------------

describe("evaluateAccessPolicyShadow — enforce mode", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let infoSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    infoSpy.mockRestore()
  })

  it("local=true, protocol=deny → returns false (protocol replaces)", () => {
    const claims = makeClaims({ access_policy: DENY_POLICY })
    const result = evaluateAccessPolicyShadow(claims, true, "enforce")
    expect(result).toBe(false)
    expect(warnSpy).toHaveBeenCalledOnce()
    const logEntry = JSON.parse(warnSpy.mock.calls[0][1])
    expect(logEntry.action_taken).toBe("protocol_wins")
  })

  it("local=false, protocol=allow → returns true (protocol replaces)", () => {
    const claims = makeClaims({ access_policy: ALLOW_POLICY })
    const result = evaluateAccessPolicyShadow(claims, false, "enforce")
    expect(result).toBe(true)
    expect(infoSpy).toHaveBeenCalledOnce()
    const logEntry = JSON.parse(infoSpy.mock.calls[0][1])
    expect(logEntry.action_taken).toBe("protocol_wins")
  })

  it("local=true, protocol=allow → no divergence, returns true", () => {
    const claims = makeClaims({ access_policy: ALLOW_POLICY })
    const result = evaluateAccessPolicyShadow(claims, true, "enforce")
    expect(result).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Error handling — fail open in observe/asymmetric, fail closed in enforce
// ---------------------------------------------------------------------------

describe("evaluateAccessPolicyShadow — error handling", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  // Invalid access_policy that will cause evaluateAccessPolicy to throw
  const INVALID_POLICY = { type: "INVALID_TYPE_THAT_DOES_NOT_EXIST", audit_required: false, revocable: false }

  it("observe: evaluation error → returns localAllowed (fail open)", () => {
    const claims = makeClaims({ access_policy: INVALID_POLICY })
    const result = evaluateAccessPolicyShadow(claims, true, "observe")
    expect(result).toBe(true)
    expect(errorSpy).toHaveBeenCalled()
  })

  it("asymmetric: evaluation error → returns localAllowed (fail open)", () => {
    const claims = makeClaims({ access_policy: INVALID_POLICY })
    const result = evaluateAccessPolicyShadow(claims, true, "asymmetric")
    expect(result).toBe(true)
    expect(errorSpy).toHaveBeenCalled()
  })

  it("enforce: evaluation error → returns false (fail closed)", () => {
    const claims = makeClaims({ access_policy: INVALID_POLICY })
    const result = evaluateAccessPolicyShadow(claims, true, "enforce")
    expect(result).toBe(false)
    expect(errorSpy).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Divergence log structure
// ---------------------------------------------------------------------------

describe("evaluateAccessPolicyShadow — divergence log structure", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it("divergence log contains all required fields", () => {
    const claims = makeClaims({ access_policy: DENY_POLICY })
    evaluateAccessPolicyShadow(claims, true, "observe")

    expect(warnSpy).toHaveBeenCalledOnce()
    const logEntry = JSON.parse(warnSpy.mock.calls[0][1])

    expect(logEntry).toEqual(expect.objectContaining({
      event: "access_policy_divergence",
      mode: "observe",
      tenant_id: "tenant-1",
      tier: "pro",
      local_allowed: true,
      protocol_allowed: false,
      protocol_reason: expect.any(String),
      action_taken: "local_wins",
    }))
  })

  it("divergence log does NOT contain sensitive fields (no token, no key)", () => {
    const claims = makeClaims({ access_policy: DENY_POLICY })
    evaluateAccessPolicyShadow(claims, true, "observe")

    const logStr = warnSpy.mock.calls[0][1]
    expect(logStr).not.toContain("req_hash")
    expect(logStr).not.toContain("abc123") // req_hash value
    expect(logStr).not.toContain("iss")
    expect(logStr).not.toContain("exp")
    expect(logStr).not.toContain("jti")
  })
})
