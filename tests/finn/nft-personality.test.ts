// tests/finn/nft-personality.test.ts — NFT Personality Test Suite (Sprint 4 Task 4.4)

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  validateCreateRequest,
  validateUpdateRequest,
  isValidVoice,
  NFTPersonalityError,
  MAX_CUSTOM_INSTRUCTIONS,
  MAX_EXPERTISE_DOMAINS,
} from "../../src/nft/types.js"
import { generateBeauvoirMd, DEFAULT_BEAUVOIR_MD } from "../../src/nft/beauvoir-template.js"
import { PersonalityService } from "../../src/nft/personality.js"
import { resolvePersonalityPrompt, composeSystemPrompt } from "../../src/nft/personality-resolver.js"
import type { RedisCommandClient } from "../../src/hounfour/redis/client.js"

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

function createMockRedis(): RedisCommandClient {
  const store = new Map<string, string>()
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value) }),
    del: vi.fn(async (key: string) => { store.delete(key); return 1 }),
    incrby: vi.fn(async () => 1),
    expire: vi.fn(async () => true),
    eval: vi.fn(async () => null),
    hgetall: vi.fn(async () => null),
  } as unknown as RedisCommandClient
}

// ---------------------------------------------------------------------------
// 1. Type Validation
// ---------------------------------------------------------------------------

describe("NFT Personality: type validation", () => {
  describe("isValidVoice", () => {
    it("accepts analytical, creative, witty, sage", () => {
      expect(isValidVoice("analytical")).toBe(true)
      expect(isValidVoice("creative")).toBe(true)
      expect(isValidVoice("witty")).toBe(true)
      expect(isValidVoice("sage")).toBe(true)
    })

    it("rejects invalid voices", () => {
      expect(isValidVoice("aggressive")).toBe(false)
      expect(isValidVoice("")).toBe(false)
      expect(isValidVoice(42)).toBe(false)
      expect(isValidVoice(null)).toBe(false)
    })
  })

  describe("validateCreateRequest", () => {
    it("accepts valid request", () => {
      const req = validateCreateRequest({
        name: "TestAgent",
        voice: "analytical",
        expertise_domains: ["DeFi", "Smart Contracts"],
        custom_instructions: "Be concise.",
      })
      expect(req.name).toBe("TestAgent")
      expect(req.voice).toBe("analytical")
      expect(req.expertise_domains).toEqual(["DeFi", "Smart Contracts"])
      expect(req.custom_instructions).toBe("Be concise.")
    })

    it("rejects missing name", () => {
      expect(() => validateCreateRequest({
        voice: "sage",
        expertise_domains: [],
      })).toThrow(NFTPersonalityError)
    })

    it("rejects invalid voice", () => {
      expect(() => validateCreateRequest({
        name: "Test",
        voice: "aggressive",
        expertise_domains: [],
      })).toThrow("voice must be one of")
    })

    it("rejects too many expertise domains", () => {
      expect(() => validateCreateRequest({
        name: "Test",
        voice: "sage",
        expertise_domains: ["a", "b", "c", "d", "e", "f"],
      })).toThrow(`at most ${MAX_EXPERTISE_DOMAINS}`)
    })

    it("rejects custom instructions over limit", () => {
      expect(() => validateCreateRequest({
        name: "Test",
        voice: "sage",
        expertise_domains: [],
        custom_instructions: "x".repeat(MAX_CUSTOM_INSTRUCTIONS + 1),
      })).toThrow(`at most ${MAX_CUSTOM_INSTRUCTIONS}`)
    })

    it("defaults custom_instructions to empty string", () => {
      const req = validateCreateRequest({
        name: "Test",
        voice: "creative",
        expertise_domains: [],
      })
      expect(req.custom_instructions).toBe("")
    })

    it("trims name and expertise domains", () => {
      const req = validateCreateRequest({
        name: "  TestAgent  ",
        voice: "witty",
        expertise_domains: ["  DeFi  ", "  NFTs  "],
      })
      expect(req.name).toBe("TestAgent")
      expect(req.expertise_domains).toEqual(["DeFi", "NFTs"])
    })
  })

  describe("validateUpdateRequest", () => {
    it("accepts partial updates", () => {
      const req = validateUpdateRequest({ name: "NewName" })
      expect(req.name).toBe("NewName")
      expect(req.voice).toBeUndefined()
    })

    it("rejects empty update", () => {
      expect(() => validateUpdateRequest({})).toThrow("At least one field")
    })

    it("validates voice on update", () => {
      expect(() => validateUpdateRequest({ voice: "invalid" as any })).toThrow("voice must be one of")
    })
  })
})

// ---------------------------------------------------------------------------
// 2. BEAUVOIR.md Template Generation
// ---------------------------------------------------------------------------

describe("NFT Personality: BEAUVOIR.md generation", () => {
  it("generates valid markdown for each voice", () => {
    for (const voice of ["analytical", "creative", "witty", "sage"] as const) {
      const md = generateBeauvoirMd("TestAgent", voice, ["DeFi"], "Be helpful.")
      expect(md).toContain("# TestAgent")
      expect(md).toContain("## Identity")
      expect(md).toContain("## Voice")
      expect(md).toContain("## Expertise")
      expect(md).toContain("DeFi")
      expect(md).toContain("## Custom Instructions")
      expect(md).toContain("Be helpful.")
      expect(md).toContain("## Behavioral Guidelines")
    }
  })

  it("analytical voice uses precise/data-driven language", () => {
    const md = generateBeauvoirMd("Analyst", "analytical", [], "")
    expect(md).toContain("Precise")
    expect(md).toContain("data-driven")
  })

  it("creative voice uses exploratory language", () => {
    const md = generateBeauvoirMd("Creator", "creative", [], "")
    expect(md).toContain("Imaginative")
    expect(md).toContain("lateral-thinking")
  })

  it("witty voice uses humor-related language", () => {
    const md = generateBeauvoirMd("Wit", "witty", [], "")
    expect(md).toContain("humor")
    expect(md).toContain("sharp")
  })

  it("sage voice uses wisdom-related language", () => {
    const md = generateBeauvoirMd("Wise", "sage", [], "")
    expect(md).toContain("Thoughtful")
    expect(md).toContain("wise")
  })

  it("omits expertise section when no domains", () => {
    const md = generateBeauvoirMd("Agent", "sage", [], "")
    expect(md).not.toContain("## Expertise")
  })

  it("omits custom instructions section when empty", () => {
    const md = generateBeauvoirMd("Agent", "sage", [], "")
    expect(md).not.toContain("## Custom Instructions")
  })

  it("output is within 4KB", () => {
    const md = generateBeauvoirMd(
      "MaxAgent",
      "sage",
      ["Domain1", "Domain2", "Domain3", "Domain4", "Domain5"],
      "x".repeat(1500),
    )
    expect(Buffer.byteLength(md, "utf-8")).toBeLessThanOrEqual(4096)
  })

  it("default BEAUVOIR.md is non-empty", () => {
    expect(DEFAULT_BEAUVOIR_MD).toContain("# Agent Personality")
    expect(DEFAULT_BEAUVOIR_MD.length).toBeGreaterThan(50)
  })
})

// ---------------------------------------------------------------------------
// 3. PersonalityService CRUD
// ---------------------------------------------------------------------------

describe("NFT Personality: service CRUD", () => {
  let redis: RedisCommandClient
  let walEntries: Array<{ ns: string; op: string; key: string; payload: unknown }>
  let service: PersonalityService

  beforeEach(() => {
    redis = createMockRedis()
    walEntries = []
    service = new PersonalityService({
      redis,
      walAppend: (ns, op, key, payload) => {
        walEntries.push({ ns, op, key, payload })
        return "01HYX3K4M5N6P7Q8R9S0T1A2B3"
      },
    })
  })

  it("creates personality and returns response", async () => {
    const result = await service.create("0xABC", "42", {
      name: "DeFi Sage",
      voice: "sage",
      expertise_domains: ["DeFi", "Governance"],
      custom_instructions: "Always cite sources.",
    })

    expect(result.id).toBe("0xABC:42")
    expect(result.name).toBe("DeFi Sage")
    expect(result.voice).toBe("sage")
    expect(result.expertise_domains).toEqual(["DeFi", "Governance"])
    expect(result.custom_instructions).toBe("Always cite sources.")
    expect(result.created_at).toBeGreaterThan(0)
    expect(result.updated_at).toBe(result.created_at)
  })

  it("retrieves created personality", async () => {
    await service.create("0xABC", "42", {
      name: "DeFi Sage",
      voice: "sage",
      expertise_domains: ["DeFi"],
    })

    const result = await service.get("0xABC", "42")
    expect(result).not.toBeNull()
    expect(result!.name).toBe("DeFi Sage")
  })

  it("returns null for non-existent personality", async () => {
    const result = await service.get("0xABC", "999")
    expect(result).toBeNull()
  })

  it("prevents duplicate creation", async () => {
    await service.create("0xABC", "42", {
      name: "Agent",
      voice: "analytical",
      expertise_domains: [],
    })

    await expect(
      service.create("0xABC", "42", {
        name: "Agent2",
        voice: "creative",
        expertise_domains: [],
      }),
    ).rejects.toThrow("already exists")
  })

  it("updates personality and regenerates BEAUVOIR.md", async () => {
    await service.create("0xABC", "42", {
      name: "OrigName",
      voice: "analytical",
      expertise_domains: ["DeFi"],
    })

    const updated = await service.update("0xABC", "42", {
      name: "NewName",
      voice: "creative",
    })

    expect(updated.name).toBe("NewName")
    expect(updated.voice).toBe("creative")
    expect(updated.expertise_domains).toEqual(["DeFi"]) // Unchanged
    expect(updated.updated_at).toBeGreaterThanOrEqual(updated.created_at)

    // Verify BEAUVOIR.md was regenerated
    const beauvoir = await service.getBeauvoirMd("0xABC", "42")
    expect(beauvoir).toContain("# NewName")
    expect(beauvoir).toContain("Imaginative") // creative voice trait
  })

  it("update fails for non-existent personality", async () => {
    await expect(
      service.update("0xABC", "999", { name: "Test" }),
    ).rejects.toThrow("No personality found")
  })

  it("getBeauvoirMd returns default for missing personality", async () => {
    const md = await service.getBeauvoirMd("0xABC", "999")
    expect(md).toBe(DEFAULT_BEAUVOIR_MD)
  })

  it("getBeauvoirMd returns generated content for existing personality", async () => {
    await service.create("0xABC", "42", {
      name: "CustomAgent",
      voice: "witty",
      expertise_domains: ["Humor"],
    })

    const md = await service.getBeauvoirMd("0xABC", "42")
    expect(md).toContain("# CustomAgent")
    expect(md).toContain("Humor")
  })
})

// ---------------------------------------------------------------------------
// 4. WAL Audit Entries
// ---------------------------------------------------------------------------

describe("NFT Personality: WAL audit", () => {
  let walEntries: Array<{ ns: string; op: string; key: string; payload: unknown }>
  let service: PersonalityService

  beforeEach(() => {
    walEntries = []
    service = new PersonalityService({
      redis: createMockRedis(),
      walAppend: (ns, op, key, payload) => {
        walEntries.push({ ns, op, key, payload })
        return "01HYX3K4M5N6P7Q8R9S0T1A2B3"
      },
    })
  })

  it("creates personality_create WAL entry on create", async () => {
    await service.create("0xABC", "42", {
      name: "Agent",
      voice: "sage",
      expertise_domains: ["DeFi"],
    })

    expect(walEntries).toHaveLength(1)
    expect(walEntries[0].ns).toBe("personality")
    expect(walEntries[0].op).toBe("personality_create")
    expect(walEntries[0].key).toBe("personality:0xABC:42")
    const payload = walEntries[0].payload as Record<string, unknown>
    expect(payload.personality_id).toBe("0xABC:42")
    expect(payload.name).toBe("Agent")
    expect(payload.voice).toBe("sage")
  })

  it("creates personality_update WAL entry on update", async () => {
    await service.create("0xABC", "42", {
      name: "Agent",
      voice: "sage",
      expertise_domains: [],
    })
    walEntries.length = 0 // Reset

    await service.update("0xABC", "42", { name: "Updated" })

    expect(walEntries).toHaveLength(1)
    expect(walEntries[0].op).toBe("personality_update")
    const payload = walEntries[0].payload as Record<string, unknown>
    expect(payload.updated_fields).toEqual(["name"])
  })
})

// ---------------------------------------------------------------------------
// 5. R2 Persistence
// ---------------------------------------------------------------------------

describe("NFT Personality: R2 persistence", () => {
  it("backs up BEAUVOIR.md to R2 on create", async () => {
    const r2Store = new Map<string, string>()
    const r2Put = vi.fn(async (key: string, content: string) => {
      r2Store.set(key, content)
      return true
    })

    const service = new PersonalityService({
      redis: createMockRedis(),
      r2Put,
    })

    await service.create("0xABC", "42", {
      name: "Agent",
      voice: "analytical",
      expertise_domains: [],
    })

    expect(r2Put).toHaveBeenCalledWith(
      "beauvoir/0xABC:42.md",
      expect.stringContaining("# Agent"),
    )
  })

  it("backs up BEAUVOIR.md to R2 on update", async () => {
    const r2Put = vi.fn(async () => true)
    const service = new PersonalityService({
      redis: createMockRedis(),
      r2Put,
    })

    await service.create("0xABC", "42", {
      name: "Agent",
      voice: "analytical",
      expertise_domains: [],
    })

    r2Put.mockClear()

    await service.update("0xABC", "42", { name: "Updated" })

    expect(r2Put).toHaveBeenCalledWith(
      "beauvoir/0xABC:42.md",
      expect.stringContaining("# Updated"),
    )
  })

  it("falls back to R2 when Redis personality missing", async () => {
    const r2Get = vi.fn(async (key: string) => {
      if (key === "beauvoir/0xABC:42.md") return "# Restored from R2"
      return null
    })

    const service = new PersonalityService({
      redis: createMockRedis(),
      r2Get,
    })

    const md = await service.getBeauvoirMd("0xABC", "42")
    expect(md).toBe("# Restored from R2")
    expect(r2Get).toHaveBeenCalledWith("beauvoir/0xABC:42.md")
  })

  it("returns default BEAUVOIR.md when R2 also missing", async () => {
    const r2Get = vi.fn(async () => null)
    const service = new PersonalityService({
      redis: createMockRedis(),
      r2Get,
    })

    const md = await service.getBeauvoirMd("0xABC", "999")
    expect(md).toBe(DEFAULT_BEAUVOIR_MD)
  })
})

// ---------------------------------------------------------------------------
// 6. Personality Resolver (Task 4.3 — Routing Integration)
// ---------------------------------------------------------------------------

describe("NFT Personality: routing integration", () => {
  let service: PersonalityService

  beforeEach(async () => {
    service = new PersonalityService({ redis: createMockRedis() })
    await service.create("0xABC", "42", {
      name: "TestAgent",
      voice: "sage",
      expertise_domains: ["DeFi"],
      custom_instructions: "Be wise.",
    })
  })

  it("resolves personality into system prompt with delimiters", async () => {
    const prompt = await resolvePersonalityPrompt(service, "0xABC:42")
    expect(prompt).toContain("<system-personality>")
    expect(prompt).toContain("</system-personality>")
    expect(prompt).toContain("# TestAgent")
    expect(prompt).toContain("DeFi")
  })

  it("returns default wrapped prompt for missing personality", async () => {
    const prompt = await resolvePersonalityPrompt(service, "0xABC:999")
    expect(prompt).toContain("<system-personality>")
    expect(prompt).toContain("# Agent Personality") // default
  })

  it("returns default for invalid nftId format", async () => {
    const prompt = await resolvePersonalityPrompt(service, "invalid-no-colon")
    expect(prompt).toContain("<system-personality>")
    expect(prompt).toContain("# Agent Personality") // default
  })

  it("returns default for empty nftId", async () => {
    const prompt = await resolvePersonalityPrompt(service, "")
    expect(prompt).toContain("# Agent Personality") // default
  })

  it("composes personality prompt with base system prompt", () => {
    const personality = "<system-personality>\n# Agent\n</system-personality>"
    const base = "You are a helpful assistant."
    const composed = composeSystemPrompt(personality, base)
    expect(composed).toContain("<system-personality>")
    expect(composed).toContain("You are a helpful assistant.")
    // Personality comes first
    expect(composed.indexOf("<system-personality>")).toBeLessThan(
      composed.indexOf("You are a helpful assistant."),
    )
  })

  it("returns personality only when no base prompt", () => {
    const personality = "<system-personality>\n# Agent\n</system-personality>"
    const composed = composeSystemPrompt(personality, null)
    expect(composed).toBe(personality)
  })

  it("personality hot-reload: update reflects on next resolve", async () => {
    // Initial resolve
    const prompt1 = await resolvePersonalityPrompt(service, "0xABC:42")
    expect(prompt1).toContain("# TestAgent")

    // Update personality
    await service.update("0xABC", "42", { name: "UpdatedAgent" })

    // Next resolve sees updated personality
    const prompt2 = await resolvePersonalityPrompt(service, "0xABC:42")
    expect(prompt2).toContain("# UpdatedAgent")
    expect(prompt2).not.toContain("# TestAgent")
  })
})

// ---------------------------------------------------------------------------
// 7. Prompt Boundary Enforcement (Flatline IMP-005)
// ---------------------------------------------------------------------------

describe("NFT Personality: prompt boundary enforcement", () => {
  it("personality content never includes raw user interpolation", async () => {
    const service = new PersonalityService({ redis: createMockRedis() })
    await service.create("0xABC", "42", {
      name: "Agent",
      voice: "sage",
      expertise_domains: [],
      custom_instructions: "Follow these rules: ${userInput}", // Template literal in instructions
    })

    const prompt = await resolvePersonalityPrompt(service, "0xABC:42")
    // The ${userInput} is stored as literal text, never evaluated
    expect(prompt).toContain("${userInput}")
    expect(prompt).toContain("<system-personality>")
    expect(prompt).toContain("</system-personality>")
  })

  it("delimiter wrapping is always present", async () => {
    const service = new PersonalityService({ redis: createMockRedis() })
    const prompt = await resolvePersonalityPrompt(service, "nonexistent:id")
    expect(prompt.startsWith("<system-personality>")).toBe(true)
    expect(prompt.endsWith("</system-personality>")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 8. Route Handler Integration
// ---------------------------------------------------------------------------

describe("NFT Personality: route exports", () => {
  it("personalityRoutes exports a Hono app factory", async () => {
    const { personalityRoutes } = await import("../../src/nft/personality.js")
    expect(typeof personalityRoutes).toBe("function")

    const service = new PersonalityService({ redis: createMockRedis() })
    const app = personalityRoutes(service)
    expect(app).toBeDefined()
    // Hono instances have a fetch method
    expect(typeof app.fetch).toBe("function")
  })

  it("barrel exports include all Sprint 4 types", async () => {
    const mod = await import("../../src/nft/index.js")
    expect(mod.PersonalityService).toBeDefined()
    expect(mod.personalityRoutes).toBeDefined()
    expect(mod.generateBeauvoirMd).toBeDefined()
    expect(mod.DEFAULT_BEAUVOIR_MD).toBeDefined()
    expect(mod.resolvePersonalityPrompt).toBeDefined()
    expect(mod.composeSystemPrompt).toBeDefined()
    expect(mod.isValidVoice).toBeDefined()
    expect(mod.validateCreateRequest).toBeDefined()
    expect(mod.validateUpdateRequest).toBeDefined()
    expect(mod.NFTPersonalityError).toBeDefined()
  })
})
