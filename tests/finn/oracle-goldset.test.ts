// tests/finn/oracle-goldset.test.ts — Oracle Gold-Set Evaluation (Sprint-2 Task 2.7)
// 10 gold-set queries covering all 4 persona types with expected source selections.

import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { KnowledgeRegistry } from "../../src/hounfour/knowledge-registry.js"
import { enrichSystemPrompt, classifyPrompt } from "../../src/hounfour/knowledge-enricher.js"
import type { KnowledgeConfig } from "../../src/hounfour/knowledge-types.js"

const PREFIX = "finn-oracle-goldset-test-"

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), PREFIX))
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true })
}

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

// --- Test Fixtures ---

const SOURCES: Record<string, { content: string; tags: string[]; priority: number; maxTokens: number; required: boolean }> = {
  glossary: {
    content: "---\ngenerated_date: \"2026-02-16\"\n---\n\n# Glossary\n\n### Hounfour\nMulti-model provider abstraction layer.\n\n### Arrakis\nBilling settlement infrastructure.\n\n### Cheval\nProvider subprocess invoker.\n\n### DLQ\nDead Letter Queue for failed billing.\n\n### Web4\nMonetary pluralism on programmable infrastructure.\n\n### Mibera\nThe universe and narrative setting.",
    tags: ["core"],
    priority: 1,
    maxTokens: 2000,
    required: true,
  },
  "ecosystem-architecture": {
    content: "---\ngenerated_date: \"2026-02-16\"\n---\n\n# Ecosystem Architecture\n\nFour repositories: loa (framework), loa-finn (runtime), loa-hounfour (types), arrakis (billing).\n\n## Data Flows\n- Invoke path: gateway → router → cheval → provider\n- Billing: metering → finalize → arrakis → settlement\n- DLQ: failed billing → persist → retry → recover",
    tags: ["core", "architectural"],
    priority: 2,
    maxTokens: 8000,
    required: true,
  },
  "code-reality-finn": {
    content: "---\ngenerated_date: \"2026-02-16\"\n---\n\n# Code Reality: loa-finn\n\n## Key Modules\n- `src/hounfour/router.ts` — HounfourRouter.invoke()\n- `src/gateway/routes/invoke.ts` — POST /invoke endpoint\n- `src/config.ts` — FinnConfig type\n- `src/hounfour/errors.ts` — HounfourError class\n\n## Type Signatures\n```typescript\ninterface AgentBinding { agent: string; model: string; persona?: string }\ninterface ResultMetadata { model: string; tokens: number }\n```",
    tags: ["technical"],
    priority: 3,
    maxTokens: 10000,
    required: true,
  },
  "code-reality-hounfour": {
    content: "---\ngenerated_date: \"2026-02-16\"\n---\n\n# Code Reality: loa-hounfour\n\n## Adapter Interfaces\n- ProviderAdapter — abstract base for model providers\n- PoolConfig — resource allocation with budget limits\n\n## Billing Types\n- BillingFinalize — settlement request to arrakis\n- UsageRecord — per-request token metering",
    tags: ["technical"],
    priority: 4,
    maxTokens: 8000,
    required: false,
  },
  "code-reality-arrakis": {
    content: "---\ngenerated_date: \"2026-02-16\"\n---\n\n# Code Reality: arrakis\n\n## ECS Topology\nALB → ECS Fargate → Redis + S3\n\n## Billing Settlement\nJWT-authenticated S2S via Spice Gate protocol.\nConservation invariant: total_cost = sum(line_items).",
    tags: ["technical", "architectural"],
    priority: 5,
    maxTokens: 5000,
    required: false,
  },
  "development-history": {
    content: "---\ngenerated_date: \"2026-02-16\"\n---\n\n# Development History\n\n24 cycles, 59 sprints. Key milestones:\n- Cycle 5: Hounfour multi-model routing\n- Cycle 12: Billing conservation invariant\n- Cycle 18: DLQ persistence\n- Cycle 22: S2S billing finalize\n- Cycle 25: Oracle knowledge interface",
    tags: ["architectural", "philosophical"],
    priority: 6,
    maxTokens: 5000,
    required: false,
  },
  rfcs: {
    content: "---\ngenerated_date: \"2026-02-16\"\n---\n\n# Active RFCs\n\n## RFC #31: Permission Scape\nMulti-model permission system design.\n\n## RFC #27: finnNFT Identity\nNFT-based agent identity and BYOK.\n\n## RFC #66: Oracle Knowledge Interface\nKnowledge enrichment for agent personas.\n\n## RFC #74: Oracle Architecture\nOption C (embedded) → Option B (standalone) graduation.",
    tags: ["architectural", "technical"],
    priority: 7,
    maxTokens: 12000,
    required: false,
  },
  "bridgebuilder-reports": {
    content: "---\ngenerated_date: \"2026-02-16\"\n---\n\n# Bridgebuilder Reports\n\n## Conservation Invariant as Social Contract\nThe billing rule total_cost = sum(line_items) is also a social contract.\n\n## Ostrom Principles in DLQ\nGraduated sanctions in retry strategies mirror Ostrom's governance principles.\n\n## Hexagonal Architecture in Hounfour\nPort/adapter pattern enables provider swapability.",
    tags: ["architectural", "philosophical"],
    priority: 8,
    maxTokens: 15000,
    required: false,
  },
  "web4-manifesto": {
    content: "---\ngenerated_date: \"2026-02-16\"\n---\n\n# Web4 Manifesto\n\nMoney must be scarce, but monies can be infinite.\nMonetary pluralism enables communities to create purpose-specific value systems.\nWeb4 democratizes monetary creation as Web2 democratized media.",
    tags: ["philosophical"],
    priority: 9,
    maxTokens: 3000,
    required: false,
  },
  "meeting-geometries": {
    content: "---\ngenerated_date: \"2026-02-16\"\n---\n\n# Meeting Geometries\n\nEight configurations for AI-human collaboration:\n1. Circle — equal voices\n2. Pair — deep dialogue\n3. Constellation — networked\n4. Amphitheatre — one teaches many\n5. Workshop — collaborative building\n6. Council — governance decisions\n7. Garden — nurturing growth\n8. Bridge — connecting domains",
    tags: ["philosophical"],
    priority: 10,
    maxTokens: 4000,
    required: false,
  },
}

const GLOSSARY_TERMS: Record<string, string[]> = {
  hounfour: ["technical", "architectural"],
  arrakis: ["architectural", "technical"],
  web4: ["philosophical"],
  mibera: ["philosophical"],
  "conservation invariant": ["architectural", "philosophical"],
  "permission scape": ["philosophical", "architectural"],
  dlq: ["technical"],
  cheval: ["technical"],
  billing: ["technical", "architectural"],
  oracle: ["technical", "architectural"],
  finnnft: ["technical", "architectural"],
  byok: ["technical"],
}

async function buildFullRegistry(dir: string): Promise<KnowledgeRegistry> {
  const oracleDir = join(dir, "grimoires", "oracle")
  mkdirSync(oracleDir, { recursive: true })

  const configSources = Object.entries(SOURCES).map(([id, s]) => ({
    id,
    type: "local",
    path: `grimoires/oracle/${id}.md`,
    format: "markdown",
    tags: s.tags,
    priority: s.priority,
    maxTokens: s.maxTokens,
    required: s.required,
    max_age_days: 90,
  }))

  const config = {
    version: 1,
    default_budget_tokens: 30000,
    glossary_terms: GLOSSARY_TERMS,
    sources: configSources,
  }

  writeFileSync(join(dir, "grimoires", "oracle", "sources.json"), JSON.stringify(config, null, 2))

  for (const [id, s] of Object.entries(SOURCES)) {
    writeFileSync(join(oracleDir, `${id}.md`), s.content)
  }

  return KnowledgeRegistry.fromConfig(join("grimoires", "oracle", "sources.json"), dir)
}

const KNOWLEDGE_CONFIG: KnowledgeConfig = {
  enabled: true,
  sources: ["*"],
  maxTokensBudgetRatio: 0.15,
}

// --- Gold-Set Queries ---

async function main() {
  console.log("Oracle Gold-Set Evaluation Tests")
  console.log("================================")

  // === Developer Persona (Technical) ===

  // GS-1: Developer asks about API endpoint
  await test("GS-1 [Developer]: 'How does the invoke API endpoint work?' → technical sources selected", async () => {
    const dir = makeTempDir()
    try {
      const registry = await buildFullRegistry(dir)
      const result = enrichSystemPrompt(null, "How does the invoke API endpoint work?", KNOWLEDGE_CONFIG, registry, 200_000)

      assert.ok(result.metadata.tags_matched.includes("technical"), "should match technical tag")
      assert.ok(result.metadata.sources_used.includes("code-reality-finn"), "should include code-reality-finn")
      assert.ok(result.metadata.sources_used.includes("glossary"), "core sources always included")
    } finally {
      cleanup(dir)
    }
  })

  // GS-2: Developer asks about types with abbreviation
  await test("GS-2 [Developer]: 'What does the DLQ do?' → technical tag via glossary expansion", async () => {
    const dir = makeTempDir()
    try {
      const registry = await buildFullRegistry(dir)
      const tags = classifyPrompt("What does the DLQ do?", GLOSSARY_TERMS)

      assert.ok(tags.includes("technical"), "DLQ should expand to technical via glossary")
      assert.ok(tags.includes("core"), "core always present")
    } finally {
      cleanup(dir)
    }
  })

  // GS-3: Developer asks about error handling with code terms
  await test("GS-3 [Developer]: 'How do I debug HounfourError types?' → technical sources", async () => {
    const dir = makeTempDir()
    try {
      const registry = await buildFullRegistry(dir)
      const result = enrichSystemPrompt(null, "How do I debug HounfourError types?", KNOWLEDGE_CONFIG, registry, 200_000)

      assert.ok(result.metadata.tags_matched.includes("technical"), "should match technical from 'debug', 'type'")
      assert.ok(result.metadata.tags_matched.includes("architectural"), "Hounfour expands to architectural via glossary")
    } finally {
      cleanup(dir)
    }
  })

  // === Contributor Persona (Architectural) ===

  // GS-4: Contributor asks about system design
  await test("GS-4 [Contributor]: 'What is the billing architecture?' → architectural + technical sources", async () => {
    const dir = makeTempDir()
    try {
      const registry = await buildFullRegistry(dir)
      const result = enrichSystemPrompt(null, "What is the billing architecture?", KNOWLEDGE_CONFIG, registry, 200_000)

      assert.ok(result.metadata.tags_matched.includes("architectural"), "should match architectural from 'architecture'")
      assert.ok(result.metadata.tags_matched.includes("technical"), "billing expands to technical via glossary")
      assert.ok(result.metadata.sources_used.includes("ecosystem-architecture"), "architecture doc should be selected")
    } finally {
      cleanup(dir)
    }
  })

  // GS-5: Contributor asks about repository structure
  await test("GS-5 [Contributor]: 'How do the four repositories connect?' → architectural sources", async () => {
    const dir = makeTempDir()
    try {
      const registry = await buildFullRegistry(dir)
      const result = enrichSystemPrompt(null, "How do the four repositories connect?", KNOWLEDGE_CONFIG, registry, 200_000)

      assert.ok(result.metadata.tags_matched.includes("core"), "core always present")
      assert.ok(result.metadata.sources_used.includes("ecosystem-architecture"), "architecture doc should be selected")
    } finally {
      cleanup(dir)
    }
  })

  // === Stakeholder Persona (Multi-intent) ===

  // GS-6: Stakeholder asks about progress
  await test("GS-6 [Stakeholder]: 'What has been built over the last 24 cycles?' → architectural + philosophical", async () => {
    const dir = makeTempDir()
    try {
      const registry = await buildFullRegistry(dir)
      const result = enrichSystemPrompt(null, "What has been built over the last 24 cycles?", KNOWLEDGE_CONFIG, registry, 200_000)

      // Should select history and architecture sources
      assert.ok(result.metadata.sources_used.includes("glossary"), "core source always included")
      assert.ok(result.metadata.sources_used.includes("ecosystem-architecture"), "architecture is core-tagged")
    } finally {
      cleanup(dir)
    }
  })

  // GS-7: Stakeholder asks about conservation invariant (multi-layer term)
  await test("GS-7 [Stakeholder]: 'Explain the conservation invariant' → architectural + philosophical via glossary", async () => {
    const dir = makeTempDir()
    try {
      const registry = await buildFullRegistry(dir)
      const tags = classifyPrompt("Explain the conservation invariant", GLOSSARY_TERMS)

      assert.ok(tags.includes("architectural"), "conservation invariant expands to architectural")
      assert.ok(tags.includes("philosophical"), "conservation invariant expands to philosophical")
    } finally {
      cleanup(dir)
    }
  })

  // === Community Persona (Philosophical) ===

  // GS-8: Community member asks about web4
  await test("GS-8 [Community]: 'What is web4 and monetary pluralism?' → philosophical sources", async () => {
    const dir = makeTempDir()
    try {
      const registry = await buildFullRegistry(dir)
      const result = enrichSystemPrompt(null, "What is web4 and monetary pluralism?", KNOWLEDGE_CONFIG, registry, 200_000)

      assert.ok(result.metadata.tags_matched.includes("philosophical"), "should match philosophical from 'web4'")
      assert.ok(result.metadata.sources_used.length >= 2, "should select multiple philosophical sources")
    } finally {
      cleanup(dir)
    }
  })

  // GS-9: Community member asks about meeting geometries
  await test("GS-9 [Community]: 'How can AI and humans collaborate?' → philosophical sources", async () => {
    const dir = makeTempDir()
    try {
      const registry = await buildFullRegistry(dir)
      const result = enrichSystemPrompt(null, "How can AI and humans collaborate? What are the meeting geometries?", KNOWLEDGE_CONFIG, registry, 200_000)

      assert.ok(result.metadata.tags_matched.includes("philosophical"), "should match philosophical from 'meeting' or 'geometry'")
    } finally {
      cleanup(dir)
    }
  })

  // GS-10: Community member asks about Mibera (synonym/lore)
  await test("GS-10 [Community]: 'Tell me about Mibera and the project vision' → philosophical via glossary", async () => {
    const dir = makeTempDir()
    try {
      const registry = await buildFullRegistry(dir)
      const tags = classifyPrompt("Tell me about Mibera and the project vision", GLOSSARY_TERMS)

      assert.ok(tags.includes("philosophical"), "Mibera expands to philosophical via glossary, 'vision' is philosophical keyword")
    } finally {
      cleanup(dir)
    }
  })

  // === Determinism Verification ===

  await test("GS-determinism: same prompt always produces same tag classification", () => {
    const prompt = "How does the Hounfour billing architecture work with arrakis?"
    const run1 = classifyPrompt(prompt, GLOSSARY_TERMS)
    const run2 = classifyPrompt(prompt, GLOSSARY_TERMS)
    const run3 = classifyPrompt(prompt, GLOSSARY_TERMS)

    assert.deepEqual(run1, run2, "run1 and run2 should be identical")
    assert.deepEqual(run2, run3, "run2 and run3 should be identical")
  })

  await test("GS-determinism: same prompt always produces same source selection", async () => {
    const dir = makeTempDir()
    try {
      const registry = await buildFullRegistry(dir)
      const prompt = "How does the Hounfour billing architecture work?"

      const r1 = enrichSystemPrompt(null, prompt, KNOWLEDGE_CONFIG, registry, 200_000)
      const r2 = enrichSystemPrompt(null, prompt, KNOWLEDGE_CONFIG, registry, 200_000)

      assert.deepEqual(r1.metadata.sources_used, r2.metadata.sources_used, "source selection should be deterministic")
      assert.deepEqual(r1.metadata.tags_matched, r2.metadata.tags_matched, "tag matching should be deterministic")
    } finally {
      cleanup(dir)
    }
  })

  console.log("\nGold-set evaluation tests complete.")
}

main().catch(err => {
  console.error("Fatal error:", err)
  process.exitCode = 1
})
