// tests/finn/task-type-gate.test.ts — Task Type Gate Tests (Tasks 2.10, 2.11)
//
// Table of Contents:
//   §1:  parseTaskType validation (Task 2.10)
//   §2:  isRegisteredTaskType (Task 2.10)
//   §3:  DEFAULT_TASK_TYPE (Task 2.10)
//   §4:  TaskType integration / round-trip (Task 2.11)
//   §5:  Tenant task type allowlist (Task 2.9 coverage)
//   §6:  Task Type → NFT routing (Task 2.7)
//   §7:  Endpoint → TaskType mapping (Task 2.7)

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  parseTaskType,
  DEFAULT_TASK_TYPE,
  isRegisteredTaskType,
  FINN_TASK_TYPES,
  resolveLegacyTaskType,
} from "../../src/hounfour/wire-boundary.js"
import { isTenantAllowlisted } from "../../src/hounfour/task-type-allowlist.js"
import {
  resolveTaskTypeToNFT,
  resolveTaskTypeFromEndpoint,
} from "../../src/hounfour/nft-routing-config.js"

// =============================================================================
// §1: parseTaskType validation (Task 2.10)
// =============================================================================

describe("Task Type Gate (Task 2.10)", () => {
  describe("parseTaskType validation", () => {
    it("parses valid namespace:type format", () => {
      const result = parseTaskType("finn:conversation")
      expect(result as string).toBe("finn:conversation")
    })

    it("rejects empty string", () => {
      expect(() => parseTaskType("")).toThrow("empty or non-string")
    })

    it("rejects string without colon", () => {
      expect(() => parseTaskType("nocolon")).toThrow("must match namespace:type")
    })

    it("rejects string exceeding 64 chars", () => {
      expect(() => parseTaskType("a".repeat(32) + ":" + "b".repeat(33))).toThrow("exceeds maximum length")
    })

    it("normalizes to lowercase", () => {
      const result = parseTaskType("FINN:CONVERSATION")
      expect(result as string).toBe("finn:conversation")
    })

    it("rejects invalid characters", () => {
      expect(() => parseTaskType("finn:con-versation")).toThrow("must match namespace:type")
    })

    it("rejects bare colon", () => {
      expect(() => parseTaskType(":")).toThrow("must match namespace:type")
    })

    it("rejects trailing colon", () => {
      expect(() => parseTaskType("finn:")).toThrow("must match namespace:type")
    })

    it("rejects leading colon", () => {
      expect(() => parseTaskType(":type")).toThrow("must match namespace:type")
    })

    it("allows underscores in namespace and type", () => {
      const result = parseTaskType("my_ns:my_type")
      expect(result as string).toBe("my_ns:my_type")
    })

    it("allows numbers in namespace and type", () => {
      const result = parseTaskType("ns1:type2")
      expect(result as string).toBe("ns1:type2")
    })
  })

  // ===========================================================================
  // §2: isRegisteredTaskType (Task 2.10)
  // ===========================================================================

  describe("isRegisteredTaskType", () => {
    it("returns true for all 6 finn-native task types", () => {
      for (const taskType of FINN_TASK_TYPES.values()) {
        expect(isRegisteredTaskType(taskType)).toBe(true)
      }
    })

    it("returns false for unknown task type", () => {
      const unknown = parseTaskType("custom:unknown")
      expect(isRegisteredTaskType(unknown)).toBe(false)
    })
  })

  // ===========================================================================
  // §3: DEFAULT_TASK_TYPE (Task 2.10)
  // ===========================================================================

  describe("DEFAULT_TASK_TYPE", () => {
    it("is finn:conversation", () => {
      expect(DEFAULT_TASK_TYPE as string).toBe("finn:conversation")
    })
  })
})

// =============================================================================
// §4: TaskType integration / round-trip (Task 2.11)
// =============================================================================

describe("TaskType Integration (Task 2.11)", () => {
  it("parseTaskType produces a branded TaskType that round-trips", () => {
    const taskType = parseTaskType("finn:conversation")
    // Round-trip: parse the string representation back
    const roundTripped = parseTaskType(taskType as string)
    expect(roundTripped as string).toBe(taskType as string)
  })

  it("FINN_TASK_TYPES contains exactly 6 entries", () => {
    expect(FINN_TASK_TYPES.size).toBe(6)
  })

  it("all FINN_TASK_TYPES are parseable by parseTaskType", () => {
    for (const [, taskType] of FINN_TASK_TYPES) {
      expect(() => parseTaskType(taskType as string)).not.toThrow()
    }
  })

  it("LEGACY_TASK_TYPE_MAP resolves all legacy strings", () => {
    const legacyStrings = ["conversation", "code_review", "analysis", "creative_writing", "summarization", "admin"]
    for (const legacy of legacyStrings) {
      const resolved = resolveLegacyTaskType(legacy)
      expect(resolved).not.toBeNull()
      // All resolved types should be registered
      expect(isRegisteredTaskType(resolved!)).toBe(true)
    }
  })

  it("resolveLegacyTaskType returns null for unknown legacy string", () => {
    expect(resolveLegacyTaskType("unknown_type")).toBeNull()
  })

  it("creative_writing maps to finn:creative (not finn:creative_writing)", () => {
    const resolved = resolveLegacyTaskType("creative_writing")
    expect(resolved as string).toBe("finn:creative")
  })
})

// =============================================================================
// §5: Tenant Task Type Allowlist (Task 2.9 coverage)
// =============================================================================

describe("Tenant Task Type Allowlist (Task 2.9 tests)", () => {
  it("isTenantAllowlisted returns false when OPEN_TASK_TYPES_ENABLED is false", () => {
    // Since the flag defaults to false, this tests the default behavior
    const taskType = parseTaskType("custom:unknown")
    expect(isTenantAllowlisted("tenant-1", taskType)).toBe(false)
  })
})

// =============================================================================
// §6: Task Type → NFT Routing (Task 2.7)
// =============================================================================

describe("Task Type → NFT Routing (Task 2.7)", () => {
  it("maps finn:conversation to chat", () => {
    expect(resolveTaskTypeToNFT(parseTaskType("finn:conversation"))).toBe("chat")
  })

  it("maps finn:code_review to code", () => {
    expect(resolveTaskTypeToNFT(parseTaskType("finn:code_review"))).toBe("code")
  })

  it("maps finn:analysis to analysis", () => {
    expect(resolveTaskTypeToNFT(parseTaskType("finn:analysis"))).toBe("analysis")
  })

  it("maps finn:creative to chat", () => {
    expect(resolveTaskTypeToNFT(parseTaskType("finn:creative"))).toBe("chat")
  })

  it("maps finn:summarization to analysis", () => {
    expect(resolveTaskTypeToNFT(parseTaskType("finn:summarization"))).toBe("analysis")
  })

  it("maps finn:admin to default", () => {
    expect(resolveTaskTypeToNFT(parseTaskType("finn:admin"))).toBe("default")
  })

  it("maps unknown type to default", () => {
    expect(resolveTaskTypeToNFT(parseTaskType("custom:unknown"))).toBe("default")
  })
})

// =============================================================================
// §7: Endpoint → TaskType Mapping (Task 2.7)
// =============================================================================

describe("Endpoint → TaskType Mapping (Task 2.7)", () => {
  it("maps /api/v1/invoke to finn:conversation", () => {
    expect(resolveTaskTypeFromEndpoint("/api/v1/invoke")).toBe("finn:conversation")
  })

  it("maps /api/v1/chat to finn:conversation", () => {
    expect(resolveTaskTypeFromEndpoint("/api/v1/chat")).toBe("finn:conversation")
  })

  it("maps /api/v1/review to finn:code_review", () => {
    expect(resolveTaskTypeFromEndpoint("/api/v1/review")).toBe("finn:code_review")
  })

  it("maps /api/v1/admin to finn:admin", () => {
    expect(resolveTaskTypeFromEndpoint("/api/v1/admin")).toBe("finn:admin")
  })

  it("maps /api/v1/invoke/sub to finn:conversation (prefix match)", () => {
    expect(resolveTaskTypeFromEndpoint("/api/v1/invoke/sub")).toBe("finn:conversation")
  })

  it("returns null for unknown endpoint", () => {
    expect(resolveTaskTypeFromEndpoint("/api/v1/unknown")).toBeNull()
  })
})
