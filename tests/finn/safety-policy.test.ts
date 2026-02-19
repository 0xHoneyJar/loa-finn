// tests/finn/safety-policy.test.ts — Safety Policy Test Suite (Sprint 8 Task 8.4)

import { describe, it, expect } from "vitest"
import {
  getSafetyPolicy,
  getSafetyPolicyText,
} from "../../src/nft/safety-policy.js"

// ---------------------------------------------------------------------------
// getSafetyPolicy() Tests
// ---------------------------------------------------------------------------

describe("getSafetyPolicy (Sprint 8 Task 8.2)", () => {
  it("returns a policy with rules array", () => {
    const policy = getSafetyPolicy()
    expect(policy).toBeDefined()
    expect(Array.isArray(policy.rules)).toBe(true)
    expect(policy.rules.length).toBeGreaterThanOrEqual(3)
  })

  it("contains SP-1 rule (harmful content)", () => {
    const policy = getSafetyPolicy()
    const sp1 = policy.rules.find((r) => r.id === "SP-1")
    expect(sp1).toBeDefined()
    expect(sp1!.description).toContain("harmful")
    expect(sp1!.promptText.length).toBeGreaterThan(0)
  })

  it("contains SP-2 rule (impersonation)", () => {
    const policy = getSafetyPolicy()
    const sp2 = policy.rules.find((r) => r.id === "SP-2")
    expect(sp2).toBeDefined()
    expect(sp2!.description).toContain("impersonation")
    expect(sp2!.promptText.length).toBeGreaterThan(0)
  })

  it("contains SP-3 rule (system internals)", () => {
    const policy = getSafetyPolicy()
    const sp3 = policy.rules.find((r) => r.id === "SP-3")
    expect(sp3).toBeDefined()
    expect(sp3!.description).toContain("system internals")
    expect(sp3!.promptText.length).toBeGreaterThan(0)
  })

  it("has at least SP-1, SP-2, SP-3 rule IDs", () => {
    const policy = getSafetyPolicy()
    const ids = policy.rules.map((r) => r.id)
    expect(ids).toContain("SP-1")
    expect(ids).toContain("SP-2")
    expect(ids).toContain("SP-3")
  })

  it("has a version string", () => {
    const policy = getSafetyPolicy()
    expect(typeof policy.version).toBe("string")
    expect(policy.version.length).toBeGreaterThan(0)
  })

  it("all rules have required fields", () => {
    const policy = getSafetyPolicy()
    for (const rule of policy.rules) {
      expect(typeof rule.id).toBe("string")
      expect(rule.id.length).toBeGreaterThan(0)
      expect(typeof rule.description).toBe("string")
      expect(rule.description.length).toBeGreaterThan(0)
      expect(typeof rule.promptText).toBe("string")
      expect(rule.promptText.length).toBeGreaterThan(0)
    }
  })

  it("returns a defensive copy (mutating result does not affect source)", () => {
    const policy1 = getSafetyPolicy()
    policy1.rules.push({ id: "SP-99", description: "test", promptText: "test" })

    const policy2 = getSafetyPolicy()
    expect(policy2.rules.length).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// getSafetyPolicyText() Tests
// ---------------------------------------------------------------------------

describe("getSafetyPolicyText (Sprint 8 Task 8.2)", () => {
  it("returns non-empty string", () => {
    const text = getSafetyPolicyText()
    expect(typeof text).toBe("string")
    expect(text.length).toBeGreaterThan(0)
  })

  it("contains all rule descriptions", () => {
    const policy = getSafetyPolicy()
    const text = getSafetyPolicyText()

    for (const rule of policy.rules) {
      expect(text, `text should contain description of ${rule.id}`).toContain(rule.description)
    }
  })

  it("contains all rule IDs in bracket format", () => {
    const text = getSafetyPolicyText()
    expect(text).toContain("[SP-1]")
    expect(text).toContain("[SP-2]")
    expect(text).toContain("[SP-3]")
  })

  it("contains all rule prompt texts", () => {
    const policy = getSafetyPolicy()
    const text = getSafetyPolicyText()

    for (const rule of policy.rules) {
      expect(text, `text should contain promptText of ${rule.id}`).toContain(rule.promptText)
    }
  })

  it("includes version header", () => {
    const policy = getSafetyPolicy()
    const text = getSafetyPolicyText()
    expect(text).toContain(`Safety Policy (v${policy.version})`)
  })
})

// ---------------------------------------------------------------------------
// Safety Policy Independence from Mode
// ---------------------------------------------------------------------------

describe("Safety Policy mode independence (Sprint 8 Task 8.2)", () => {
  it("safety policy is not affected by mode — always returns same rules", () => {
    // Safety is separate from dAPM dials; calling getSafetyPolicy() multiple
    // times always returns the same rules regardless of any external state.
    const policy1 = getSafetyPolicy()
    const policy2 = getSafetyPolicy()

    expect(policy1.rules.length).toBe(policy2.rules.length)
    expect(policy1.version).toBe(policy2.version)

    for (let i = 0; i < policy1.rules.length; i++) {
      expect(policy1.rules[i].id).toBe(policy2.rules[i].id)
      expect(policy1.rules[i].description).toBe(policy2.rules[i].description)
      expect(policy1.rules[i].promptText).toBe(policy2.rules[i].promptText)
    }
  })

  it("getSafetyPolicyText() is stable across calls", () => {
    const text1 = getSafetyPolicyText()
    const text2 = getSafetyPolicyText()
    expect(text1).toBe(text2)
  })
})
