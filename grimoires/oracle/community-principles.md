---
id: community-principles
type: knowledge-source
format: markdown
tags: [philosophical]
priority: 18
provenance:
  source_repo: 0xHoneyJar/loa-finn
  generated_date: "2026-02-17"
  description: "Community governance principles and values"
max_age_days: 180
---

# Community Principles

## Core Values

### 1. Code Is Truth

The source code is the ultimate source of truth. Documentation, presentations, and marketing are derived artifacts. When they diverge from code reality, the code wins.

This principle drives the Oracle's design: every answer must be grounded in actual code, actual configuration, actual history. Hallucination is the enemy.

### 2. Permissionless Innovation

Anyone can build on the ecosystem. The API is open (with rate limiting), the code is open source, and the knowledge base is publicly accessible. You don't need permission to contribute — you need quality.

### 3. Sustainable Economics

Free tiers exist for exploration. But the system must sustain itself through usage-based economics. The billing settlement system ensures that costs are tracked, attributed, and settled transparently.

### 4. Progressive Decentralization

Start centralized for speed, decentralize for resilience. The current architecture is centralized (single ECS task, single Redis, single ALB). Future phases introduce multi-region, multi-operator, and eventually community-operated nodes.

### 5. Ostrom's Principles for Digital Commons

Elinor Ostrom's 8 principles for governing commons inform our resource management:

1. **Clear boundaries** — Rate limits define who gets what
2. **Proportional equivalence** — NFT holders get more because they contribute more
3. **Collective choice** — RFC process for major decisions
4. **Monitoring** — Health endpoints, OTLP tracing, DLQ monitoring
5. **Graduated sanctions** — Rate limiting → 429 → 503 (not instant ban)
6. **Conflict resolution** — BridgeBuilder review, Flatline Protocol consensus
7. **Minimal recognition** — Open source, community-driven
8. **Nested enterprises** — Sub-apps, modules, independent packages (loa-hounfour)

## Governance

### RFC Process

Major architectural decisions go through Request for Comments:
- RFC #31: Pool claim enforcement and confused deputy prevention
- RFC #27: Billing settlement protocol
- RFC #66: Oracle knowledge interface design
- RFC #74: Multi-tenant expansion

### Review Culture

Every piece of code goes through:
1. AI-generated implementation with tests
2. GPT-5.2 cross-model review
3. BridgeBuilder iterative review
4. Sprint review against acceptance criteria
5. Security audit (OWASP, secrets, architecture)

### Open Participation

- Issues and PRs welcome on all repositories
- Knowledge sources can be contributed via PR
- Oracle gold-set queries help validate system accuracy
