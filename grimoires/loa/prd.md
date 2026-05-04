# PRD: Per-NFT Personality — Pipeline Wiring + Scale-Out Design

**Status:** Draft
**Author:** Jani + Claude
**Date:** 2026-03-26
**Cycle:** 040
**References:** [Issue #132](https://github.com/0xHoneyJar/loa-finn/issues/132) · [Issue #133](https://github.com/0xHoneyJar/loa-finn/issues/133) (Soft Launch Checklist) · [Issue #131](https://github.com/0xHoneyJar/loa-finn/issues/131) (Critical Path)

---

## 1. Problem Statement

The finnNFT personality engine is 85% built across 68 files (~18K lines in `src/nft/`). The DAMP-96 derivation engine, BEAUVOIR synthesizer, anti-narration framework, on-chain reader, signal cache, personality store, name derivation, and experience engine all exist as working code. However, **none of this is connected to the chat session flow**. Users currently interact with 4 generic static personalities loaded from `config/personalities.json` via `StaticPersonalityLoader`.

The gap is the "last mile" — wiring existing components into a pipeline triggered by session creation: `tokenId → on-chain read → DAMP-96 derivation → BEAUVOIR synthesis → personality injection`. Additionally, the identity graph (`identity-graph.ts`) and experience engine (`experience-engine.ts`) are fully implemented but never invoked.

This cycle delivers the soft launch: 5-10 team members chatting with distinct, on-chain-derived agent personalities. It also documents the scale-out architecture for 100K+ NFTs.

> Sources: Issue #132 (full spec), Code analysis of `src/nft/` (68 files), `agent-chat.ts` session flow, `config/personalities.json` (4 static entries)

---

## 2. Goals & Success Metrics

### 2.1 Business Objectives

- **Soft launch ready**: 5-10 team members chatting with distinct dNFT agents on production
- **Product thesis validated**: "The art and the agent are the same thing expressed in different modalities" — on-chain traits produce personality
- **Scale-out architecture designed**: Caching, batch derivation, and degradation patterns documented for 100K+ NFTs

### 2.2 Quantitative Success Criteria

| Metric | Target | Measurement |
|--------|--------|-------------|
| DAMP fingerprint distinctiveness | Cosine similarity < 0.7 between any two agents | `src/nft/eval/distinctiveness.ts` |
| BEAUVOIR synthesis latency | < 10s per generation (Opus) | Circuit breaker telemetry |
| Streaming response start | < 3s for cached personalities | Gateway latency metrics |
| Anti-narration violation rate | 0% on generated BEAUVOIR docs | `validateAntiNarration()` assertions |
| Cache hit rate (soft launch) | 100% for pre-computed demo IDs | Redis cache metrics |

### 2.3 Qualitative Success Criteria

| Criteria | Validation |
|----------|------------|
| Team members rate personality quality 4+/5 | Post-chat feedback during soft launch |
| Users can distinguish agents by conversation alone | Blind test: guess which archetype from conversation |
| Personality feels "alive", not templated | Subjective team assessment |

> Sources: Issue #133 "Wow Criteria", Phase 2 interview

---

## 3. User & Stakeholder Context

### 3.1 Primary Persona: finnNFT Holder

- **Access**: Connects wallet, SIWE authentication
- **Interaction**: Web chat at `/chat/{tokenId}`, Discord `/agent` command
- **Ownership model**: Own NFT only — `on-chain-reader.ts:readOwner(tokenId)` must match SIWE wallet
- **Soft launch scope**: 5-10 allowlisted team members (`CHAT_ALLOWED_ADDRESSES`)

### 3.2 Stakeholders

| Stakeholder | Interest | Involvement |
|-------------|----------|-------------|
| @janitooor | Primary maintainer, PR reviewer | Approval on all implementation |
| Team members | Soft launch testers | Quality feedback on personality distinctiveness |

> Sources: Issue #133 Gate 5 (access control), Phase 3 interview

---

## 4. Functional Requirements

### FR-1: End-to-End Pipeline Wiring

**When** a user creates a chat session with a `tokenId`, **the system shall** resolve personality through this pipeline:

```
Session creation (agent-chat.ts)
  → Verify ownership: readOwner(tokenId) == SIWE wallet
  → Check cache: PersonalityStore.get(tokenId) → Redis → Postgres
  → Cache miss: OnChainReader.readSignals(tokenId)
  → Signal derivation: buildSignalSnapshot() → deriveDAMP()
  → Identity graph: KnowledgeGraphLoader.extractSubgraph()
  → BEAUVOIR synthesis: BeauvoirSynthesizer.synthesize() [Opus]
  → Store: PersonalityStore.write() [Redis + Postgres dual-write]
  → Resolve: resolvePersonalityPrompt() → inject into system prompt
```

**Integration points** (existing code to wire):
- `src/nft/on-chain-reader.ts` → `readSignals(tokenId)` returns `SignalSnapshot`
- `src/nft/signal-engine.ts` → `buildSignalSnapshot()` constructs full signal
- `src/nft/damp.ts` → `deriveDAMP(snapshot)` returns `DAMPFingerprint` (96 dials)
- `src/nft/identity-graph.ts` → `extractSubgraph(archetype, ancestor, era, element)` returns `SynthesisSubgraph`
- `src/nft/beauvoir-synthesizer.ts` → `synthesize(fingerprint, signals, subgraph)` returns BEAUVOIR.md
- `src/nft/personality-resolver.ts` → `resolvePersonalityPrompt()` wraps in `<system-personality>` delimiters
- `src/nft/personality-context.ts` → `buildPersonalityContext()` creates protocol v4.5 context
- `src/nft/name-derivation.ts` → `nameKDF(signals)` returns canonical agent name

**Concurrency control (SKP-004):** The pipeline MUST use a per-token distributed lock (Redis `SET NX` with expiry) to prevent duplicate Opus synthesis for the same tokenId. Concurrent requests for the same token wait on the lock rather than triggering parallel synthesis. Writes use compare-and-swap by content hash to prevent last-writer-wins corruption.

**Dual-write consistency (SKP-003):** Postgres is the source of truth. Write order: Postgres first (with idempotency key), then Redis cache. On read, if Redis and Postgres disagree (content hash mismatch), perform read-repair from Postgres. Store `personality_version` / `content_hash` in both stores for mismatch detection.

**BEAUVOIR sanitization (SKP-008):** Generated BEAUVOIR content MUST be sanitized before storage: strip/escape `<system-personality>` delimiter tokens and any system-role directives. Validate against allowed sections/headers and enforce length limits. The anti-narration validator already catches some adversarial patterns; add delimiter-specific checks.

**WebSocket loading sequence (IMP-002):** For cold-cache resolution (up to 20s), the WebSocket MUST send a structured loading state frame: `{ "type": "personality_loading", "stage": "on_chain_read|damp_derivation|synthesis|caching", "progress_percent": N }`. Client renders a loading indicator until `{ "type": "personality_ready", "agent_name": "...", "archetype": "..." }` is received.

**Experience engine ordering (IMP-005):** Drift is applied at read-time, NOT during synthesis. The canonical order is: `birth_fingerprint` (immutable) + `stored_drift_offsets` (versioned, Postgres) = `effective_fingerprint` (computed). Synthesis uses the `effective_fingerprint`. Drift offsets are updated asynchronously post-session via atomic Postgres transaction with optimistic concurrency.

**Acceptance criteria**:
- A tokenId in the WebSocket query produces a personality derived from on-chain traits, not from static config
- Ownership verification rejects non-owners with appropriate error
- Pipeline completes within 20s on cold cache, <1s on warm cache
- Concurrent requests for same tokenId do not trigger duplicate synthesis
- Postgres is always consistent; Redis may lag but self-heals via read-repair
- Generated BEAUVOIR content cannot break out of system-personality delimiters

> Sources: Issue #132 Sprint 1, Flatline SKP-004 (HIGH:760), SKP-003 (HIGH:770), SKP-008 (CRITICAL:940), IMP-002, IMP-005

### FR-2: Identity Graph Integration

**The system shall** inject cultural references, aesthetic preferences, and philosophical foundations from the identity graph into the BEAUVOIR synthesis prompt.

**Current state**: `identity-graph.ts` (483 lines) has `extractSubgraph()`, `resolveCulturalReferences()`, `resolveAestheticPreferences()`, `resolvePhilosophicalFoundations()` — all implemented. `buildSynthesisPrompt()` has slots for this data but receives empty inputs.

**Task**: Wire `KnowledgeGraphLoader.extractSubgraph()` output into `BeauvoirSynthesizer.buildSynthesisPrompt()` so the synthesis prompt includes:
- Cultural references from ancestor's codex neighborhood (hop depth = 2)
- Aesthetic notes from archetype affinity
- Philosophical lineage from era + element nodes

**Acceptance criteria**:
- Generated BEAUVOIR docs reference cultural context appropriate to the ancestor
- Two agents with different ancestors produce visibly different cultural grounding

> Sources: Code analysis (`identity-graph.ts:483`, `beauvoir-synthesizer.ts:511`)

### FR-3: Experience Engine Wiring

**The system shall** track interactions per personality and apply gradual dial drift over time.

**Current state**: `experience-engine.ts` (322 lines) fully implements:
- Epoch triggers after N interactions
- Per-dial exponential decay with 30-day half-life
- Drift formula: `impact * exp(-ln(2)/30 * age_days)`
- Clamping: ±0.5% per epoch, ±5% cumulative from birth values
- `experience-accumulator.ts`, `experience-rebase.ts`, `experience-config.ts` all implemented

**Task**: Wire experience engine into personality resolution path:
- After each session, increment interaction counter
- On epoch trigger, compute dial drift from accumulated interactions
- Apply drift offsets during `resolvePersonalityPrompt()` before synthesis
- Store experience state in Redis/Postgres

**Acceptance criteria**:
- Interaction count tracked per tokenId
- After N interactions (configurable epoch size), personality dials shift within ±0.5% bounds
- Cumulative drift never exceeds ±5% from birth values

> Sources: Code analysis (`experience-engine.ts`, `experience-types.ts`, `experience-accumulator.ts`)

### FR-4: Pre-Computed Demo Personalities

**The system shall** support pre-computing personality derivations for known tokenIds.

**Task**: Create a script/command that:
1. Takes a list of tokenIds (or reads from config)
2. Runs the full pipeline: on-chain read → DAMP → identity graph → BEAUVOIR synthesis → cache write
3. Validates anti-narration on each generated BEAUVOIR
4. Reports distinctiveness scores between all generated personalities

**For soft launch**: Use test/mock tokenIds initially, swap for real team-owned IDs before launch.

**Acceptance criteria**:
- 5 personalities pre-computed and cached
- All pass anti-narration validation
- Pairwise cosine similarity < 0.7

> Sources: Issue #132 Sprint 3, Phase 5 interview

### FR-5: Chat Metadata — Name & Archetype

**The system shall** expose the agent's derived name and archetype in API response metadata and chat page UX.

**loa-finn (API)**:
- Include `agent_name` (from `nameKDF()`), `archetype`, `era` in session creation response
- Include in WebSocket personality metadata frame

**loa-freeside (UX)**:
- Update `chat-page.routes.ts` to display agent name instead of generic "Agent Chat"
- Show archetype/era as flavor text
- Optionally show tarot card or zodiac as visual flair

**Acceptance criteria**:
- Chat page shows derived agent name (e.g., "Kael Tempest" not "Agent #1")
- Archetype visible as secondary metadata

> Sources: Issue #132 Sprint 3 Task 3.4, Phase 3/6 interview

### FR-6: Centralized Ownership Verification Gate

**When** a user attempts to create a chat session via ANY entry point (HTTP, WebSocket, Discord, or future paths), **the system shall** verify NFT ownership through a single centralized function:

```
verifyOwnership(tokenId, wallet) → centralized service function
  → On-chain ownerOf() call (NOT cached for auth decisions)
  → Match against SIWE-authenticated wallet address
  → Allow if match, reject with 403 if mismatch
  → Short TTL owner cache (60s max) for repeated checks within same session
```

**Centralization requirement (SKP-001):** All session creation paths MUST route through a single `verifyOwnership()` function. Deny-by-default: if tokenId is present but ownership not validated, reject. Integration tests MUST cover every entry point.

**Ownership cache TTL (SKP-002):** Ownership data MUST NOT use the 24h signal cache. Auth-layer ownership uses a separate 60s TTL cache. On NFT transfer, `transfer-listener.ts` invalidates immediately. Store `blockNumber` with ownership reads for staleness detection.

**Active-session transfer behavior (IMP-004):** If ownership changes during an active session, the current session completes but no new sessions are allowed for the old owner. Transfer invalidation is eventual (within 60s TTL) for in-flight sessions.

**Acceptance criteria**:
- Non-owners receive 403 with clear error message on ALL entry points
- Ownership check uses 60s TTL cache (NOT 24h signal cache)
- Transfer events invalidate ownership cache immediately
- Soft launch: also checks `CHAT_ALLOWED_ADDRESSES` allowlist
- Integration tests cover HTTP, WebSocket, and any other session creation paths

> Sources: Issue #133 Gate 5, Flatline SKP-001 (CRITICAL:910), SKP-002 (CRITICAL:880), IMP-004 (HIGH_CONSENSUS)

### FR-7: Fallback & Degradation Chain

**If** any pipeline stage fails, **the system shall** degrade gracefully:

| Failure | Fallback |
|---------|----------|
| On-chain read fails | Use cached signals if available, else reject |
| DAMP derivation fails | Should not fail (pure function), but reject if input invalid |
| Identity graph load fails | Synthesize without cultural grounding (empty subgraph) |
| BEAUVOIR synthesis fails (circuit breaker open) | Use cached BEAUVOIR if available, else use static fallback |
| Redis unavailable | Fall through to Postgres, then on-chain |

**Acceptance criteria**:
- No pipeline failure produces an unhandled error
- Degradation logged with severity for monitoring
- Static fallback (`config/personalities.json`) is the last resort, never the default

> Sources: Code analysis (circuit breaker in `beauvoir-synthesizer.ts`, `personality-provider-chain.ts` fallback order)

---

## 5. Technical & Non-Functional Requirements

### 5.1 Performance

| Metric | Target |
|--------|--------|
| Cached personality resolution | < 100ms |
| Cold cache (on-chain + synthesis) | < 20s (with loading state) |
| Pre-computed personality load | < 50ms |
| Streaming response start | < 3s after personality resolved |

### 5.2 Synthesis Model

- **Model**: Claude Opus for BEAUVOIR generation
- **Rationale**: Highest personality depth and nuance for the "wow" factor
- **Cost**: One-time per personality (cached after generation)

### 5.3 Caching Architecture

| Layer | Store | TTL | Purpose |
|-------|-------|-----|---------|
| Signal cache | Redis | 24h | On-chain signal snapshots |
| Personality store | Redis + Postgres | 1h / permanent | BEAUVOIR docs + DAMP fingerprints |
| R2 backup | S3-compatible | Permanent | BEAUVOIR.md versioned backup |
| Identity graph cache | Redis | 24h | Codex subgraphs |

**Already built**: `signal-cache.ts`, `personality-store.ts`, `identity-graph.ts:IdentityGraphCache`

### 5.4 Security

- Ownership verification via on-chain `ownerOf()` before session creation
- Anti-narration validation (7 constraints) on every BEAUVOIR generation
- Temporal voice domain checking per era
- SIWE + JWT auth chain (existing)
- Soft launch allowlist (`CHAT_ALLOWED_ADDRESSES`)

### 5.5 Scale-Out Design (Architecture Documentation)

Document (not implement) the following patterns for 100K+ NFTs:

1. **Batch derivation**: Pre-compute DAMP fingerprints for all minted tokenIds during off-peak hours
2. **Cache warming**: Proactive synthesis for frequently accessed agents (top 1000 by interaction count)
3. **Synthesis queue**: Rate-limited BEAUVOIR generation to prevent Opus API burst
4. **Degradation tiers**: Full personality → cached BEAUVOIR → generic archetype template → static fallback
5. **Transfer invalidation**: `transfer-listener.ts` already exists — document integration with cache invalidation

> Sources: Phase 5 interview, `transfer-listener.ts` (231 lines, implemented)

---

## 6. Scope & Prioritization

### 6.1 In Scope (This Cycle)

| Priority | Feature | Repos |
|----------|---------|-------|
| P0 | FR-1: Pipeline wiring (tokenId → personality → session) | loa-finn |
| P0 | FR-6: Ownership verification gate | loa-finn |
| P0 | FR-7: Fallback & degradation chain | loa-finn |
| P1 | FR-2: Identity graph integration into synthesis | loa-finn |
| P1 | FR-3: Experience engine wiring | loa-finn |
| P1 | FR-4: Pre-computed demo personalities (5 test tokenIds) | loa-finn |
| P2 | FR-5: Chat metadata — name & archetype display | loa-finn + loa-freeside |
| P2 | Scale-out architecture documentation | loa-finn (docs) |

### 6.2 Explicitly Out of Scope

| Feature | Reason |
|---------|--------|
| Governance/DAO voting enforcement | Post-launch feature, governance_model field exists but enforcement deferred |
| Routing affinity enforcement in hounfour | Partial wire exists, not needed for soft launch |
| Agent mode switching endpoint | Post-launch personalization feature |
| Flatline review integration for synthesis | Quality gate, not critical path |
| Discord bot personality integration | Separate work track in loa-freeside |
| Eval harness integration into CI | Quality tooling, not launch-blocking |
| Personality versioning UI | API-level versioning exists, UI deferred |

### 6.3 Cross-Repo Work

| Repo | Work | Effort |
|------|------|--------|
| **loa-finn** | Pipeline wiring, identity graph, experience engine, demo personalities | Primary dev work |
| **loa-freeside** | Chat page: display agent name/archetype from API metadata | Light UX update |

> Sources: Phase 6 interview, Issue #132 Sprint breakdown

---

## 7. Risks & Dependencies

### 7.1 Technical Risks

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| Opus synthesis latency (10s+) blocks first session | High | Medium | Pre-compute for known IDs, loading state for cold cache |
| On-chain reader RPC failures (rate limits, network) | Medium | Medium | Circuit breaker + fallback chain (cache → Postgres → static) |
| Anti-narration false positives rejecting valid BEAUVOIR | Medium | Low | Retry loop (2 retries) with violation feedback already built |
| Identity graph missing codex data for some combos | Low | Low | `extractSubgraph()` returns empty subgraph gracefully |
| Experience engine drift accumulating incorrectly | Medium | Low | ±5% cumulative clamp, rebase mechanism exists |
| Cross-repo coordination overhead (finn + freeside) | Low | Medium | API contract first, UX second |

### 7.2 Dependencies

| Dependency | Status | Risk |
|------------|--------|------|
| `ANTHROPIC_API_KEY` configured for Opus | Available in production secrets | None |
| Redis for personality caching | Running in staging + production | None |
| RPC endpoint for finnNFT contract | Configured via `ALCHEMY_API_KEY` | Rate limit risk at scale |
| IPFS gateway for metadata | Configured in `on-chain-reader.ts` | Latency risk |
| 5 test tokenIds for demo | To be created with mock on-chain data | Low |
| Postgres for dual-write | Running, schema needs personality tables | Migration required |

### 7.3 Assumptions

1. **[ASSUMPTION]** `BeauvoirSynthesizer.buildSynthesisPrompt()` handles all 12 DAMP categories adequately — enrichment needs identity graph wiring, not prompt restructuring. **If wrong**: Sprint 2 scope expands.
2. **[ASSUMPTION]** Experience engine wiring doesn't affect synthesis latency — epoch checks are fast, drift computation is pure math. **If wrong**: Experience engine needs async processing path.
3. **[ASSUMPTION]** `agent-chat.ts` is the sole session creation path. **If wrong**: Discord and other entry points need the same pipeline wiring.

> Sources: Phase 7 interview, code analysis

---

## 8. Appendix: Existing Code Inventory

### 8.1 Pipeline Components (All in `src/nft/`)

| Component | File | Lines | Status |
|-----------|------|-------|--------|
| Signal types & constants | `signal-types.ts` | 308 | Complete |
| Signal engine | `signal-engine.ts` | 391 | Complete |
| DAMP-96 derivation | `damp.ts` | 305 | Complete |
| DAMP offset tables | `damp-tables.ts` | 126 | Complete |
| BEAUVOIR synthesizer | `beauvoir-synthesizer.ts` | 511 | Complete |
| BEAUVOIR template | `beauvoir-template.ts` | 112 | Complete (fallback) |
| Anti-narration (7 constraints) | `anti-narration.ts` | 701 | Complete |
| Temporal voice domain | `temporal-voice.ts` | 206 | Complete |
| On-chain reader | `on-chain-reader.ts` | 400 | Complete |
| Signal cache (Redis 24h) | `signal-cache.ts` | 123 | Complete |
| Personality store (Redis+Pg) | `personality-store.ts` | 228 | Complete |
| Personality service (CRUD) | `personality.ts` | 1331 | Complete |
| Personality resolver | `personality-resolver.ts` | 289 | Complete |
| Personality context (v4.5) | `personality-context.ts` | 248 | Complete |
| Personality provider chain | `personality-provider-chain.ts` | 62 | Complete |
| Static personality loader | `static-personality-loader.ts` | 170 | Complete (legacy) |
| Name derivation (HKDF) | `name-derivation.ts` | 229 | Complete |
| Identity graph | `identity-graph.ts` | 483 | Complete, **not wired** |
| Experience engine | `experience-engine.ts` | 322 | Complete, **not wired** |
| Experience accumulator | `experience-accumulator.ts` | 244 | Complete, **not wired** |
| Experience config | `experience-config.ts` | 226 | Complete, **not wired** |
| Experience rebase | `experience-rebase.ts` | 202 | Complete, **not wired** |
| First contact | `first-contact.ts` | 93 | Complete |
| Entropy ceremony | `entropy.ts` | 696 | Complete |
| Transfer listener | `transfer-listener.ts` | 231 | Complete |
| Codex data loader | `codex-data/loader.ts` | — | Complete |

### 8.2 Current Session Flow (What Changes)

**Before** (static):
```
agent-chat.ts → StaticPersonalityLoader → personalities.json → generic prompt
```

**After** (dynamic):
```
agent-chat.ts
  → verifyOwnership(tokenId, siweWallet)
  → PersonalityProviderChain.get(tokenId)
    → PersonalityStore (Redis → Postgres)
    → [cache miss] OnChainReader.readSignals(tokenId)
    → deriveDAMP(snapshot)
    → KnowledgeGraphLoader.extractSubgraph(...)
    → BeauvoirSynthesizer.synthesize(fingerprint, signals, subgraph) [Opus]
    → PersonalityStore.write(tokenId, personality) [dual-write]
    → ExperienceEngine.applyDrift(fingerprint, tokenId) [if epochs accumulated]
  → resolvePersonalityPrompt(personality)
  → buildPersonalityContext(personality)
  → compose system prompt with <system-personality> delimiters
  → invoke model with personality context
```
