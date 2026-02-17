---
id: product-vision
type: knowledge-source
format: markdown
tags: [philosophical, architectural]
priority: 13
provenance:
  source_repo: 0xHoneyJar/loa-finn
  generated_date: "2026-02-17"
  description: "Product vision and strategic direction"
max_age_days: 180
---

# Product Vision: The Honey Jar Ecosystem

## Mission

Build permissionless, self-sustaining infrastructure for community-driven AI agents. The Honey Jar (THJ) creates tools where communities own their AI capabilities through token-gated access and transparent economic mechanisms.

## The Three Pillars

### 1. Accessibility Through Token Gating

finnNFT holders get prioritized access to AI infrastructure. This isn't a paywall — it's a community membership that aligns incentives. NFT holders benefit from system improvements; system improvements are funded by usage.

### 2. Transparency Through Open Source

Every component is open source:
- **loa** — Agent development framework
- **loa-finn** — API gateway and model router
- **loa-hounfour** — Multi-model provider abstraction
- **arrakis** — Infrastructure and billing settlement

The code IS the documentation. The Oracle's knowledge comes directly from the codebase, not from marketing materials.

### 3. Sustainability Through Economic Design

The billing settlement system (S2S JWT → arrakis finalize endpoint) creates a sustainable economic loop:
1. Users invoke models through Finn
2. Finn tracks costs per-request with micro-USD precision
3. Costs settle to the arrakis billing contract
4. Revenue funds infrastructure and development

## The Oracle's Role

The Oracle is the first product surface — a knowledge interface that makes the ecosystem's complexity accessible. It answers questions about:

- **Technical**: How does the routing work? What's the JWT flow?
- **Architectural**: Why was this design chosen? What are the trade-offs?
- **Philosophical**: What is monetary pluralism? What are meeting geometries?
- **Product**: How do I integrate? What's the roadmap?

The Oracle embodies the vision: AI that is grounded in code reality, not hallucination. Every answer cites actual source files, actual design decisions, actual history.

## Strategic Direction

### Phase 0 (DONE): Knowledge Engine
Build the enrichment pipeline that grounds AI responses in project knowledge.

### Phase 1 (IN PROGRESS): Product Surface
Ship the Oracle API with rate limiting, auth, and a frontend at oracle.arrakis.community.

### Phase 2 (PLANNED): Multi-Tenant
Expand to support multiple communities running their own Oracle instances with custom knowledge bases.

### Phase 3 (FUTURE): Agent Marketplace
Enable community members to create and share specialized agents through the Hounfour router.
