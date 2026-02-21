// tests/nft/static-personality-loader.test.ts — Static Personality Loader Tests (Sprint 4 T4.1-T4.4)

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { writeFileSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { StaticPersonalityLoader } from "../../src/nft/static-personality-loader.js"

const TEST_DIR = join(process.cwd(), "tmp-test-personalities")

function writeTempConfig(filename: string, content: unknown): string {
  const path = join(TEST_DIR, filename)
  writeFileSync(path, JSON.stringify(content, null, 2))
  return path
}

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true })
})

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// T4.1: Config schema validation
// ---------------------------------------------------------------------------

describe("T4.1: Static personality config schema", () => {
  it("loads valid config with all 4 archetypes", () => {
    const path = writeTempConfig("valid.json", {
      personalities: [
        makePersonality("1", "freetekno"),
        makePersonality("2", "milady"),
        makePersonality("3", "chicago_detroit"),
        makePersonality("4", "acidhouse"),
      ],
    })

    const loader = new StaticPersonalityLoader(path)
    expect(loader.size).toBe(4)
  })

  it("rejects missing file", () => {
    expect(() => new StaticPersonalityLoader("/nonexistent/path.json"))
      .toThrow("Static personality config not found")
  })

  it("rejects invalid JSON", () => {
    const path = join(TEST_DIR, "invalid.json")
    writeFileSync(path, "not json {{{")

    expect(() => new StaticPersonalityLoader(path))
      .toThrow("not valid JSON")
  })

  it("rejects empty personalities array", () => {
    const path = writeTempConfig("empty.json", { personalities: [] })

    expect(() => new StaticPersonalityLoader(path))
      .toThrow("at least one personality entry")
  })

  it("rejects missing required fields", () => {
    const path = writeTempConfig("missing-field.json", {
      personalities: [{ token_id: "1" }],
    })

    expect(() => new StaticPersonalityLoader(path))
      .toThrow('"archetype" must be a non-empty string')
  })

  it("rejects invalid archetype", () => {
    const path = writeTempConfig("bad-archetype.json", {
      personalities: [makePersonality("1", "invalid_archetype" as never)],
    })

    expect(() => new StaticPersonalityLoader(path))
      .toThrow('invalid archetype "invalid_archetype"')
  })

  it("rejects duplicate token_id", () => {
    const path = writeTempConfig("dupe.json", {
      personalities: [
        makePersonality("1", "freetekno"),
        makePersonality("1", "milady"),
      ],
    })

    expect(() => new StaticPersonalityLoader(path))
      .toThrow('Duplicate token_id "1"')
  })
})

// ---------------------------------------------------------------------------
// T4.2 + T4.3: PersonalityProvider interface + loader
// ---------------------------------------------------------------------------

describe("T4.2/T4.3: PersonalityProvider interface", () => {
  let loader: StaticPersonalityLoader

  beforeAll(() => {
    const path = writeTempConfig("provider.json", {
      personalities: [
        makePersonality("10", "freetekno"),
        makePersonality("20", "milady"),
        makePersonality("30", "chicago_detroit"),
        makePersonality("40", "acidhouse"),
      ],
    })
    loader = new StaticPersonalityLoader(path)
  })

  it("get() returns personality for valid tokenId", async () => {
    const p = await loader.get("10")
    expect(p).not.toBeNull()
    expect(p!.token_id).toBe("10")
    expect(p!.archetype).toBe("freetekno")
    expect(p!.beauvoir_template).toBeTruthy()
    expect(p!.behavioral_traits.length).toBeGreaterThan(0)
    expect(p!.expertise_domains.length).toBeGreaterThan(0)
  })

  it("get() returns null for unknown tokenId", async () => {
    const p = await loader.get("999")
    expect(p).toBeNull()
  })

  it("has() returns true for known tokenId", async () => {
    expect(await loader.has("20")).toBe(true)
  })

  it("has() returns false for unknown tokenId", async () => {
    expect(await loader.has("999")).toBe(false)
  })

  it("getAll() returns all loaded personalities", () => {
    const all = loader.getAll()
    expect(all.length).toBe(4)
    const archetypes = all.map(p => p.archetype).sort()
    expect(archetypes).toEqual(["acidhouse", "chicago_detroit", "freetekno", "milady"])
  })

  it("each personality has all required fields", async () => {
    for (const tokenId of ["10", "20", "30", "40"]) {
      const p = await loader.get(tokenId)
      expect(p).not.toBeNull()
      expect(typeof p!.token_id).toBe("string")
      expect(typeof p!.archetype).toBe("string")
      expect(typeof p!.display_name).toBe("string")
      expect(typeof p!.voice_description).toBe("string")
      expect(typeof p!.beauvoir_template).toBe("string")
      expect(Array.isArray(p!.behavioral_traits)).toBe(true)
      expect(Array.isArray(p!.expertise_domains)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// T4.4: Anti-narration validation at boot
// ---------------------------------------------------------------------------

describe("T4.4: Anti-narration boot validation", () => {
  it("rejects template with forbidden archetype term", () => {
    const path = writeTempConfig("forbidden-archetype.json", {
      personalities: [
        makePersonality("1", "freetekno", "You are a freetekno agent."),
      ],
    })

    expect(() => new StaticPersonalityLoader(path))
      .toThrow("forbidden anti-narration terms")
    expect(() => new StaticPersonalityLoader(path))
      .toThrow("freetekno")
  })

  it("rejects template with forbidden system term (beauvoir)", () => {
    const path = writeTempConfig("forbidden-beauvoir.json", {
      personalities: [
        makePersonality("1", "milady", "Follow the beauvoir specification carefully."),
      ],
    })

    expect(() => new StaticPersonalityLoader(path))
      .toThrow("forbidden anti-narration terms")
  })

  it("rejects template with forbidden ancestor name", () => {
    const path = writeTempConfig("forbidden-ancestor.json", {
      personalities: [
        makePersonality("1", "acidhouse", "Channel the wisdom of pythagoras."),
      ],
    })

    expect(() => new StaticPersonalityLoader(path))
      .toThrow("forbidden anti-narration terms")
  })

  it("rejects template with forbidden meta-identity term (archetype)", () => {
    const path = writeTempConfig("forbidden-meta.json", {
      personalities: [
        makePersonality("1", "freetekno", "Your archetype determines your behavior."),
      ],
    })

    expect(() => new StaticPersonalityLoader(path))
      .toThrow("forbidden anti-narration terms")
  })

  it("accepts template without forbidden terms", () => {
    const path = writeTempConfig("clean.json", {
      personalities: [
        makePersonality("1", "freetekno", "You are a direct, systems-oriented conversational agent."),
      ],
    })

    // Should not throw
    const loader = new StaticPersonalityLoader(path)
    expect(loader.size).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// T4.1: Production config validation
// ---------------------------------------------------------------------------

describe("Production config/personalities.json", () => {
  it("loads successfully with all anti-narration checks passing", () => {
    const loader = new StaticPersonalityLoader("config/personalities.json")
    expect(loader.size).toBe(4)
  })

  it("has all 4 archetypes represented", () => {
    const loader = new StaticPersonalityLoader("config/personalities.json")
    const archetypes = loader.getAll().map(p => p.archetype).sort()
    expect(archetypes).toEqual(["acidhouse", "chicago_detroit", "freetekno", "milady"])
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePersonality(
  tokenId: string,
  archetype: string,
  template?: string,
) {
  return {
    token_id: tokenId,
    archetype,
    display_name: `Agent #${tokenId}`,
    voice_description: "Test voice",
    behavioral_traits: ["Test trait"],
    expertise_domains: ["Test domain"],
    beauvoir_template: template ?? "You are a helpful conversational agent that provides thoughtful analysis.",
  }
}
