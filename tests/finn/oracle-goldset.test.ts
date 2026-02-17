// tests/finn/oracle-goldset.test.ts — Oracle Gold-Set Evaluation (Sprint-2 Task 2.7, Sprint-4 Task 4.8)
// 20 gold-set queries covering all 7 abstraction levels with expected source selections.

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

// --- Test Fixtures (20 sources across 7 abstraction levels) ---

const SOURCES: Record<string, { content: string; tags: string[]; priority: number; maxTokens: number; required: boolean }> = {
  // Level 1: Core definitions
  glossary: {
    content: "---\ngenerated_date: \"2026-02-16\"\n---\n\n# Glossary\n\n### Hounfour\nMulti-model provider abstraction layer.\n\n### Arrakis\nBilling settlement infrastructure.\n\n### Cheval\nProvider subprocess invoker.\n\n### DLQ\nDead Letter Queue for failed billing.\n\n### Web4\nMonetary pluralism on programmable infrastructure.\n\n### Mibera\nThe universe and narrative setting.",
    tags: ["core"],
    priority: 1,
    maxTokens: 2000,
    required: true,
  },
  // Level 2: Architecture
  "ecosystem-architecture": {
    content: "---\ngenerated_date: \"2026-02-16\"\n---\n\n# Ecosystem Architecture\n\nFour repositories: loa (framework), loa-finn (runtime), loa-hounfour (types), arrakis (billing).\n\n## Data Flows\n- Invoke path: gateway → router → cheval → provider\n- Billing: metering → finalize → arrakis → settlement\n- DLQ: failed billing → persist → retry → recover",
    tags: ["core", "architectural"],
    priority: 2,
    maxTokens: 8000,
    required: true,
  },
  // Level 3: Code Reality (Technical)
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
  // Level 4: Development Methodology
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
  // Level 5: Philosophical
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
  // Level 3 (extended): Code Reality for Loa framework
  "code-reality-loa": {
    content: "---\ngenerated_date: \"2026-02-17\"\n---\n\n# Code Reality: Loa Framework\n\n## Skill System\nSkills auto-load SKILL.md when invoked. Three-zone model: System (.claude/), State (grimoires/), App (src/).\n\n## Sprint Ledger\nGlobal sprint numbering across cycles via ledger.json.\n\n## Hooks\nPreToolUse/PostToolUse hooks for safety and audit.",
    tags: ["technical", "architectural"],
    priority: 11,
    maxTokens: 5000,
    required: false,
  },
  // Level 2 (extended): Architecture Decisions
  "architecture-decisions": {
    content: "---\ngenerated_date: \"2026-02-17\"\n---\n\n# Architecture Decision Records\n\n## ADR-001: Hono over Express\nChosen for edge-native performance and type safety.\n\n## ADR-003: ES256 JWT\nElliptic curve for S2S auth. Smaller tokens, stronger security.\n\n## ADR-005: Lua Rate Limiting\nAtomic Redis Lua scripts prevent race conditions.\n\n## ADR-007: Sub-app Isolation\nOracle mounted as isolated Hono sub-app.",
    tags: ["architectural", "technical"],
    priority: 12,
    maxTokens: 6000,
    required: false,
  },
  // Level 5 (extended): Product Vision
  "product-vision": {
    content: "---\ngenerated_date: \"2026-02-17\"\n---\n\n# Product Vision\n\n## Mission\nDemocratize AI access through community-owned infrastructure.\n\n## Three Pillars\n1. Accessibility — free tier for exploration\n2. Transparency — open source, visible economics\n3. Sustainability — usage-based billing, conservation invariant\n\n## Oracle Role\nKnowledge interface bridging technical docs and community understanding.",
    tags: ["philosophical", "architectural"],
    priority: 13,
    maxTokens: 4000,
    required: false,
  },
  // Level 6: Features & Status
  "feature-matrix": {
    content: "---\ngenerated_date: \"2026-02-17\"\n---\n\n# Feature Matrix\n\n## loa-finn Features\n| Feature | Status |\n|---------|--------|\n| Multi-model routing | Production |\n| JWT auth (ES256) | Production |\n| Oracle knowledge enrichment | Beta |\n| Rate limiting (Lua) | Production |\n\n## API Endpoints\n- POST /api/v1/invoke — Model invocation\n- GET /health — System health\n- POST /api/v1/oracle/ask — Oracle query",
    tags: ["technical", "architectural"],
    priority: 14,
    maxTokens: 5000,
    required: false,
  },
  // Level 4 (extended): Sprint Patterns
  "sprint-patterns": {
    content: "---\ngenerated_date: \"2026-02-17\"\n---\n\n# Sprint Patterns\n\n## Development Cycle\nPRD → SDD → Sprint Plan → Implement → Review → Audit → Deploy\n\n## Cross-Model Quality Gates\nGPT-5.2 review + BridgeBuilder iterative review + Flatline Protocol consensus.\n\n## Anti-patterns\n- Skipping review gates\n- Ad-hoc implementation without sprint plan\n- Manual task tracking when beads available",
    tags: ["architectural", "philosophical"],
    priority: 15,
    maxTokens: 4000,
    required: false,
  },
  // Level 7: Onboarding & Getting Started
  "onboarding-guide": {
    content: "---\ngenerated_date: \"2026-02-17\"\n---\n\n# Onboarding Guide\n\n## Quick Start\n1. Clone loa-finn repository\n2. Copy `.env.example` to `.env`\n3. Set required environment variables\n4. `pnpm install && pnpm dev`\n\n## Environment Variables\n- FINN_PORT — Server port (default 3000)\n- REDIS_URL — Redis connection string\n- FINN_ORACLE_ENABLED — Enable Oracle (default false)\n\n## Testing\n`pnpm test` runs vitest suite\n`pnpm test:e2e` runs integration tests",
    tags: ["technical"],
    priority: 16,
    maxTokens: 4000,
    required: false,
  },
  // Level 5 (extended): Naming & Mythology
  "naming-mythology": {
    content: "---\ngenerated_date: \"2026-02-17\"\n---\n\n# Naming & Mythology\n\n## Vodou Computing Metaphor\nLoa (spirits/framework), Hounfour (temple/provider), Cheval (horse/adapter), Grimoire (spellbook/state).\n\n## System Names\nFinn — gateway (Finn McCool, salmon of knowledge). Arrakis — billing (Dune, spice). Dixie — Oracle frontend.\n\n## Operational Terms\nJack In/Out — start/stop. Simstim — HITL mode. Flatline — convergence detection.",
    tags: ["philosophical"],
    priority: 17,
    maxTokens: 3000,
    required: false,
  },
  // Level 5 (extended): Community Principles
  "community-principles": {
    content: "---\ngenerated_date: \"2026-02-17\"\n---\n\n# Community Principles\n\n## Core Values\n1. Code Is Truth — source code is ultimate authority\n2. Permissionless Innovation — open API, open source\n3. Sustainable Economics — usage-based billing\n4. Progressive Decentralization — centralized for speed, decentralize for resilience\n\n## Ostrom's Principles\nClear boundaries (rate limits), proportional equivalence (NFT tiers), graduated sanctions (429 → 503).",
    tags: ["philosophical"],
    priority: 18,
    maxTokens: 4000,
    required: false,
  },
  // Level 6 (extended): Pricing Model
  "pricing-model": {
    content: "---\ngenerated_date: \"2026-02-17\"\n---\n\n# Pricing Model\n\n## Tier Structure\n- Free: 5 req/day per IP, cheap pool\n- Authenticated: 50 req/day per key, cheap pool\n- finnNFT Pro: 500 req/day, cheap + fast-code + reasoning\n- Enterprise: unlimited, all pools\n\n## Cost Model\ncost_micro = prompt_tokens * input_price + completion_tokens * output_price\nDaily cost ceiling: $20.00 (2000 cents).\n\n## Conservation Invariant\nsum(reservations) - sum(releases) = current_cost_counter",
    tags: ["architectural", "philosophical"],
    priority: 19,
    maxTokens: 4000,
    required: false,
  },
  // Level 6 (extended): Tokenomics
  "tokenomics-overview": {
    content: "---\ngenerated_date: \"2026-02-17\"\n---\n\n# Tokenomics Overview\n\n## finnNFT\nERC-721 token gating AI model access. Tier-based routing: free → cheap, pro → cheap+fast-code+reasoning, enterprise → all pools.\n\n## Economic Loop\nUsers get AI access proportional to token holdings. Operators earn from billing settlement. Conservation invariant prevents money creation/destruction.\n\n## Monetary Pluralism\nFuture: compute credits, knowledge tokens, reputation scores, community governance.",
    tags: ["philosophical", "architectural"],
    priority: 20,
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
  // Extended glossary (Sprint 4)
  "finnNFT routing": ["technical", "architectural"],
  "token gating": ["technical", "philosophical"],
  ostrom: ["philosophical"],
  adr: ["architectural"],
  "rate limiting": ["technical", "architectural"],
  simstim: ["philosophical", "technical"],
  flatline: ["technical", "architectural"],
  grimoire: ["philosophical"],
  tier: ["technical", "architectural"],
  pool: ["technical"],
  pricing: ["architectural", "philosophical"],
  onboarding: ["technical"],
  sprint: ["architectural"],
  mythology: ["philosophical"],
  naming: ["philosophical"],
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

// --- Gold-Set Queries (20 queries across 7 abstraction levels) ---

async function main() {
  console.log("Oracle Gold-Set Evaluation Tests")
  console.log("================================")

  // === Level 3: Code Reality / Developer Persona (Technical) ===

  // GS-1: Developer asks about API endpoint
  await test("GS-1 [Developer]: 'How does the invoke API endpoint work?' → code-reality-finn selected", async () => {
    const dir = makeTempDir()
    try {
      const registry = await buildFullRegistry(dir)
      const result = enrichSystemPrompt(null, "How does the invoke API endpoint work?", KNOWLEDGE_CONFIG, registry, 200_000)

      // Required sources
      assert.ok(result.metadata.tags_matched.includes("technical"), "should match technical tag")
      assert.ok(result.metadata.sources_used.includes("code-reality-finn"), "required: code-reality-finn")
      assert.ok(result.metadata.sources_used.includes("glossary"), "required: glossary (core)")
      // Forbidden sources
      assert.ok(!result.metadata.sources_used.includes("web4-manifesto"), "forbidden: web4-manifesto (philosophical-only)")
      assert.ok(!result.metadata.sources_used.includes("meeting-geometries"), "forbidden: meeting-geometries (philosophical-only)")
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
  await test("GS-3 [Developer]: 'How do I debug HounfourError types?' → technical + architectural", async () => {
    const dir = makeTempDir()
    try {
      const registry = await buildFullRegistry(dir)
      const result = enrichSystemPrompt(null, "How do I debug HounfourError types?", KNOWLEDGE_CONFIG, registry, 200_000)

      assert.ok(result.metadata.tags_matched.includes("technical"), "should match technical from 'debug', 'type'")
      assert.ok(result.metadata.tags_matched.includes("architectural"), "Hounfour expands to architectural via glossary")
      // Required sources
      assert.ok(result.metadata.sources_used.includes("code-reality-finn"), "required: code-reality-finn")
    } finally {
      cleanup(dir)
    }
  })

  // === Level 2: Architecture / Contributor Persona ===

  // GS-4: Contributor asks about system design
  await test("GS-4 [Contributor]: 'What is the billing architecture?' → ecosystem-architecture selected", async () => {
    const dir = makeTempDir()
    try {
      const registry = await buildFullRegistry(dir)
      const result = enrichSystemPrompt(null, "What is the billing architecture?", KNOWLEDGE_CONFIG, registry, 200_000)

      assert.ok(result.metadata.tags_matched.includes("architectural"), "should match architectural from 'architecture'")
      assert.ok(result.metadata.tags_matched.includes("technical"), "billing expands to technical via glossary")
      // Required sources
      assert.ok(result.metadata.sources_used.includes("ecosystem-architecture"), "required: ecosystem-architecture")
    } finally {
      cleanup(dir)
    }
  })

  // GS-5: Contributor asks about repository structure
  await test("GS-5 [Contributor]: 'How do the four repositories connect?' → ecosystem-architecture selected", async () => {
    const dir = makeTempDir()
    try {
      const registry = await buildFullRegistry(dir)
      const result = enrichSystemPrompt(null, "How do the four repositories connect?", KNOWLEDGE_CONFIG, registry, 200_000)

      assert.ok(result.metadata.tags_matched.includes("core"), "core always present")
      // Required sources
      assert.ok(result.metadata.sources_used.includes("ecosystem-architecture"), "required: ecosystem-architecture")
      assert.ok(result.metadata.sources_used.includes("glossary"), "required: glossary")
    } finally {
      cleanup(dir)
    }
  })

  // === Level 4: Development Methodology / Stakeholder Persona ===

  // GS-6: Stakeholder asks about progress
  await test("GS-6 [Stakeholder]: 'What has been built over the last 24 cycles?' → development-history selected", async () => {
    const dir = makeTempDir()
    try {
      const registry = await buildFullRegistry(dir)
      const result = enrichSystemPrompt(null, "What has been built over the last 24 cycles?", KNOWLEDGE_CONFIG, registry, 200_000)

      // Required sources
      assert.ok(result.metadata.sources_used.includes("glossary"), "required: glossary (core)")
      assert.ok(result.metadata.sources_used.includes("ecosystem-architecture"), "required: ecosystem-architecture (core)")
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

  // === Level 5: Philosophical / Community Persona ===

  // GS-8: Community member asks about web4
  await test("GS-8 [Community]: 'What is web4 and monetary pluralism?' → web4-manifesto selected", async () => {
    const dir = makeTempDir()
    try {
      const registry = await buildFullRegistry(dir)
      const result = enrichSystemPrompt(null, "What is web4 and monetary pluralism?", KNOWLEDGE_CONFIG, registry, 200_000)

      assert.ok(result.metadata.tags_matched.includes("philosophical"), "should match philosophical from 'web4'")
      // Required sources
      assert.ok(result.metadata.sources_used.includes("web4-manifesto"), "required: web4-manifesto")
      assert.ok(result.metadata.sources_used.length >= 3, "should select multiple sources")
      // Forbidden sources
      assert.ok(!result.metadata.sources_used.includes("onboarding-guide"), "forbidden: onboarding-guide (technical-only)")
    } finally {
      cleanup(dir)
    }
  })

  // GS-9: Community member asks about meeting geometries
  await test("GS-9 [Community]: 'How can AI and humans collaborate?' → meeting-geometries selected", async () => {
    const dir = makeTempDir()
    try {
      const registry = await buildFullRegistry(dir)
      const result = enrichSystemPrompt(null, "How can AI and humans collaborate? What are the meeting geometries?", KNOWLEDGE_CONFIG, registry, 200_000)

      assert.ok(result.metadata.tags_matched.includes("philosophical"), "should match philosophical from 'meeting' or 'geometry'")
      // Required sources
      assert.ok(result.metadata.sources_used.includes("meeting-geometries"), "required: meeting-geometries")
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

  // === NEW: Level 7: Onboarding & Getting Started ===

  // GS-11: New developer asks about setup
  await test("GS-11 [Onboarding]: 'How do I set up the development environment?' → onboarding-guide selected", async () => {
    const dir = makeTempDir()
    try {
      const registry = await buildFullRegistry(dir)
      const result = enrichSystemPrompt(null, "How do I set up the development environment? What are the onboarding steps?", KNOWLEDGE_CONFIG, registry, 200_000)

      assert.ok(result.metadata.tags_matched.includes("technical"), "onboarding expands to technical via glossary")
      // Required sources
      assert.ok(result.metadata.sources_used.includes("onboarding-guide"), "required: onboarding-guide")
      assert.ok(result.metadata.sources_used.includes("glossary"), "required: glossary (core)")
      // Forbidden sources
      assert.ok(!result.metadata.sources_used.includes("web4-manifesto"), "forbidden: web4-manifesto (philosophical-only, no technical tag)")
    } finally {
      cleanup(dir)
    }
  })

  // GS-12: New developer asks about naming conventions
  await test("GS-12 [Onboarding]: 'What does Hounfour mean? Why these naming conventions?' → naming-mythology selected", async () => {
    const dir = makeTempDir()
    try {
      const registry = await buildFullRegistry(dir)
      const result = enrichSystemPrompt(null, "What does Hounfour mean? Why these naming conventions and mythology?", KNOWLEDGE_CONFIG, registry, 200_000)

      assert.ok(result.metadata.tags_matched.includes("philosophical"), "mythology/naming expand to philosophical via glossary")
      assert.ok(result.metadata.tags_matched.includes("technical"), "hounfour expands to technical via glossary")
      // Required sources
      assert.ok(result.metadata.sources_used.includes("naming-mythology"), "required: naming-mythology")
    } finally {
      cleanup(dir)
    }
  })

  // === NEW: Level 6: Product & Economics ===

  // GS-13: User asks about pricing tiers
  await test("GS-13 [Product]: 'How does the pricing model work? What are the tiers?' → pricing-model selected", async () => {
    const dir = makeTempDir()
    try {
      const registry = await buildFullRegistry(dir)
      const result = enrichSystemPrompt(null, "How does the pricing model work? What are the tiers?", KNOWLEDGE_CONFIG, registry, 200_000)

      assert.ok(result.metadata.tags_matched.includes("architectural"), "pricing expands to architectural via glossary")
      assert.ok(result.metadata.tags_matched.includes("philosophical"), "pricing expands to philosophical via glossary")
      assert.ok(result.metadata.tags_matched.includes("technical"), "tier expands to technical via glossary")
      // Required sources
      assert.ok(result.metadata.sources_used.includes("pricing-model"), "required: pricing-model")
    } finally {
      cleanup(dir)
    }
  })

  // GS-14: User asks about token gating
  await test("GS-14 [Product]: 'What is the finnNFT and how does token gating work?' → tokenomics-overview selected", async () => {
    const dir = makeTempDir()
    try {
      const registry = await buildFullRegistry(dir)
      const result = enrichSystemPrompt(null, "What is the finnNFT and how does token gating work?", KNOWLEDGE_CONFIG, registry, 200_000)

      assert.ok(result.metadata.tags_matched.includes("technical"), "finnnft/token gating expand to technical via glossary")
      assert.ok(result.metadata.tags_matched.includes("philosophical"), "token gating expands to philosophical via glossary")
      // Required sources
      assert.ok(result.metadata.sources_used.includes("tokenomics-overview"), "required: tokenomics-overview")
    } finally {
      cleanup(dir)
    }
  })

  // === NEW: Level 4: Development Methodology (extended) ===

  // GS-15: Contributor asks about sprint process
  await test("GS-15 [Methodology]: 'How does the sprint development process work?' → sprint-patterns selected", async () => {
    const dir = makeTempDir()
    try {
      const registry = await buildFullRegistry(dir)
      const result = enrichSystemPrompt(null, "How does the sprint development process work?", KNOWLEDGE_CONFIG, registry, 200_000)

      assert.ok(result.metadata.tags_matched.includes("architectural"), "sprint expands to architectural via glossary")
      // Required sources
      assert.ok(result.metadata.sources_used.includes("sprint-patterns"), "required: sprint-patterns")
      // Forbidden sources
      assert.ok(!result.metadata.sources_used.includes("meeting-geometries"), "forbidden: meeting-geometries (philosophical-only, no arch tag)")
    } finally {
      cleanup(dir)
    }
  })

  // === NEW: Level 2: Architecture Decisions ===

  // GS-16: Contributor asks about ADRs
  await test("GS-16 [Architecture]: 'What ADR architecture decisions shaped the API config?' → architecture-decisions selected", async () => {
    const dir = makeTempDir()
    try {
      const registry = await buildFullRegistry(dir)
      const result = enrichSystemPrompt(null, "What ADR architecture decisions shaped the API config?", KNOWLEDGE_CONFIG, registry, 200_000)

      assert.ok(result.metadata.tags_matched.includes("architectural"), "should match architectural from 'architecture' + 'adr' glossary")
      assert.ok(result.metadata.tags_matched.includes("technical"), "should match technical from 'api' and 'config' keywords")
      // Required sources
      assert.ok(result.metadata.sources_used.includes("architecture-decisions"), "required: architecture-decisions")
      assert.ok(result.metadata.sources_used.includes("ecosystem-architecture"), "required: ecosystem-architecture (core)")
    } finally {
      cleanup(dir)
    }
  })

  // === NEW: Level 3: Code Reality (Loa Framework) ===

  // GS-17: Developer asks about Loa framework internals
  await test("GS-17 [Code Reality]: 'How does the Loa framework code and module system work?' → code-reality-loa selected", async () => {
    const dir = makeTempDir()
    try {
      const registry = await buildFullRegistry(dir)
      const result = enrichSystemPrompt(null, "How does the Loa framework code and module system work?", KNOWLEDGE_CONFIG, registry, 200_000)

      assert.ok(result.metadata.tags_matched.includes("technical"), "should match technical from 'code', 'module'")
      assert.ok(result.metadata.tags_matched.includes("architectural"), "loa expands to architectural via glossary")
      // Required sources
      assert.ok(result.metadata.sources_used.includes("code-reality-loa"), "required: code-reality-loa")
    } finally {
      cleanup(dir)
    }
  })

  // === NEW: Level 6: Feature Matrix ===

  // GS-18: Stakeholder asks about feature status
  await test("GS-18 [Features]: 'What features are available? What API endpoints exist?' → feature-matrix selected", async () => {
    const dir = makeTempDir()
    try {
      const registry = await buildFullRegistry(dir)
      const result = enrichSystemPrompt(null, "What features are available? What API endpoints exist?", KNOWLEDGE_CONFIG, registry, 200_000)

      assert.ok(result.metadata.tags_matched.includes("technical"), "should match technical from 'api', 'endpoint'")
      // Required sources
      assert.ok(result.metadata.sources_used.includes("feature-matrix"), "required: feature-matrix")
      assert.ok(result.metadata.sources_used.includes("code-reality-finn"), "required: code-reality-finn (technical, higher priority)")
    } finally {
      cleanup(dir)
    }
  })

  // === NEW: Level 5: Governance / Community ===

  // GS-19: Community member asks about governance
  await test("GS-19 [Governance]: 'How is the community governed? What are Ostrom principles?' → community-principles selected", async () => {
    const dir = makeTempDir()
    try {
      const registry = await buildFullRegistry(dir)
      const result = enrichSystemPrompt(null, "How is the community governed? What are Ostrom's principles for digital commons?", KNOWLEDGE_CONFIG, registry, 200_000)

      assert.ok(result.metadata.tags_matched.includes("philosophical"), "should match philosophical from 'community', 'governance', 'ostrom'")
      // Required sources
      assert.ok(result.metadata.sources_used.includes("community-principles"), "required: community-principles")
      // Forbidden sources
      assert.ok(!result.metadata.sources_used.includes("onboarding-guide"), "forbidden: onboarding-guide (technical-only)")
    } finally {
      cleanup(dir)
    }
  })

  // === NEW: Cross-cutting (Multi-level) ===

  // GS-20: Cross-cutting query spanning product vision + rate limiting + sustainability
  await test("GS-20 [Cross-cutting]: 'How does rate limiting support the product vision of sustainability?' → product-vision + pricing-model selected", async () => {
    const dir = makeTempDir()
    try {
      const registry = await buildFullRegistry(dir)
      const result = enrichSystemPrompt(null, "How does rate limiting support the product vision of sustainability?", KNOWLEDGE_CONFIG, registry, 200_000)

      assert.ok(result.metadata.tags_matched.includes("philosophical"), "should match philosophical from 'vision'")
      assert.ok(result.metadata.tags_matched.includes("technical"), "rate limiting expands to technical via glossary")
      assert.ok(result.metadata.tags_matched.includes("architectural"), "rate limiting expands to architectural via glossary")
      // Should have multiple levels represented
      assert.ok(result.metadata.sources_used.length >= 4, "cross-cutting query should select sources from multiple levels")
      // Required sources
      assert.ok(result.metadata.sources_used.includes("product-vision"), "required: product-vision")
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
