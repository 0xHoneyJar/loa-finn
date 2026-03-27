# Scale-Out Design: Per-NFT Personality at 100K+ Agents

**Cycle:** 040 | **Sprint:** 3 (G164) | **Date:** 2026-03-26
**Status:** Architecture documentation (not implemented)
**PRD Reference:** Section 5.5

---

## Overview

The current personality pipeline (PersonalityPipelineOrchestrator) is designed for soft launch: 5-10 team members with pre-computed personalities and on-demand synthesis for cold cache misses. This document describes the architectural patterns needed to scale to 100K+ unique agent personalities.

---

## 1. Batch Derivation

**Problem:** At 100K tokens, on-demand synthesis (10s per personality via Opus) would take ~11.5 days sequentially for the first cold-cache population.

**Pattern:** Off-peak cron job iterates all minted tokenIds, pre-computes DAMP fingerprints and caches them in Postgres.

```
Cron (daily, 2-4am UTC)
  → Query contract: totalSupply()
  → For each tokenId not in finn_personalities:
    → SignalCache.getSignals(tokenId) [RPC + IPFS]
    → deriveDAMP(snapshot, "default")
    → Store fingerprint in finn_personality_versions (no BEAUVOIR yet)
  → Report: N new fingerprints cached
```

**Key decisions:**
- Fingerprint derivation is pure math (~1ms per token) — batch the RPC/IPFS reads, not the derivation
- BEAUVOIR synthesis is deferred to first-access (Opus calls are expensive)
- Use `scripts/precompute-personalities.ts` as the foundation, extended with RPC pool batching

**Capacity:** At 50 RPC calls/second (Alchemy Growth plan), 100K tokens take ~33 minutes for signal reads. Fingerprint derivation adds negligible time.

---

## 2. Cache Warming

**Problem:** First-access BEAUVOIR synthesis takes 10-15s. Popular agents get thundering herd on launch.

**Pattern:** Proactive synthesis for the top N agents by interaction count.

```
Cron (weekly or on-deploy)
  → Query finn_experience_snapshots ORDER BY interaction_count DESC LIMIT 1000
  → For each without cached BEAUVOIR:
    → BeauvoirSynthesizer.synthesize(snapshot, fingerprint, subgraph)
    → PersonalityStore.write(config, personalityId)
  → Report: N personalities warmed
```

**Key decisions:**
- ExperienceStore provides the ranking (most-interacted agents get warmed first)
- Rate limit Opus calls to 10/minute to avoid API burst
- Use singleflight lock to prevent concurrent warming + user access collision
- Warming runs on a separate worker (not the hot-path ECS task)

**Cost estimate:** 1000 Opus calls × ~$0.15 each = ~$150/week. Acceptable if interaction frequency justifies it.

---

## 3. Synthesis Queue

**Problem:** Burst of first-time visitors (e.g., after marketing push) could overwhelm the Opus API.

**Pattern:** Rate-limited job queue for BEAUVOIR generation.

```
Cold cache miss
  → Check queue: is synthesis already pending for this tokenId?
    → Yes: subscribe to completion notification
    → No: enqueue synthesis job
  → Return loading state to WebSocket

Queue worker (separate process)
  → Dequeue job
  → Rate limit: max 10 concurrent Opus calls
  → On completion: write to PersonalityStore, notify waiters
  → On failure: retry with backoff (max 3), then serve fallback
```

**Technology options:**
- **BullMQ** (Redis-backed): Consistent with existing Redis infrastructure
- **SQS + Lambda**: Decoupled, auto-scaling, but adds AWS complexity
- **In-process queue**: Simplest, but doesn't survive deploys

**Recommendation:** BullMQ for initial scale-out. The existing Redis infrastructure supports it, and the singleflight lock pattern already uses Redis for coordination. Migration to SQS later if needed.

---

## 4. Degradation Tiers

**Problem:** Not all failures should produce the same user experience.

**Pattern:** Four-tier degradation with distinct UX for each.

| Tier | Condition | User Experience | Data Quality |
|------|-----------|-----------------|-------------|
| **Full** | BEAUVOIR + subgraph + experience | Distinct personality with cultural grounding and learned drift | 100% |
| **Cached** | BEAUVOIR from previous synthesis | Distinct personality, may be slightly stale | 90% |
| **Archetype** | Generic template for archetype | One of 4 archetype voices, not personalized | 40% |
| **Static** | config/personalities.json fallback | Generic "Agent #N" — last resort | 10% |

**Implementation (already partially built):**
- Tiers 1-2: Handled by `PersonalityPipelineOrchestrator` fallback chain
- Tier 3: Add archetype-specific templates (4 templates, one per archetype) as a fallback between cached BEAUVOIR and static config
- Tier 4: Existing `StaticPersonalityLoader` → `config/personalities.json`

**Monitoring:** Each degradation tier is logged with `finn.personality_pipeline` structured metric (already implemented). Add Tier classification to the metric for dashboard alerting.

---

## 5. Transfer Invalidation

**Problem:** When an NFT is transferred, the new owner should get a fresh personality derivation, not the previous owner's cached version.

**Pattern:** Event-driven cache invalidation via `transfer-listener.ts`.

```
ERC-721 Transfer event
  → TransferListener.handleTransferLog()
    → invalidateOwnerCache(collection, tokenId)     [existing - siwe-ownership.ts]
    → invalidateOwnershipCache(redis, tokenId)       [Sprint 1 - ownership-gate.ts, 60s auth cache]
    → PersonalityStore.invalidate(tokenId)           [Sprint 3 - personality cache]
    → SignalCache.invalidate(tokenId)                [Sprint 3 - signal cache]
```

**What happens on next access:**
1. New owner authenticates via SIWE
2. OwnershipGate verifies on-chain `ownerOf()` → matches new wallet
3. Pipeline runs fresh: signals (same), DAMP (same — signals are token-bound, not owner-bound), BEAUVOIR (same — personality is derived from token signals, not owner identity)
4. Personality is re-cached for the new owner's session

**Key insight:** Personality is *token-derived*, not *owner-derived*. A transfer changes who can *access* the agent, not who the agent *is*. The signals are on-chain properties of the NFT, not the wallet. This is a feature, not a bug — the agent maintains identity continuity across ownership changes.

**Exception:** The experience engine tracks interactions per personality, not per owner. When ownership transfers, accumulated experience persists. This mirrors the real-world analogy: selling a house doesn't erase the history of who lived there.

---

## Capacity Planning

| Resource | Soft Launch (10 users) | Scale-Out (100K tokens) |
|----------|----------------------|------------------------|
| Redis memory | ~100KB | ~500MB (personality configs) |
| Postgres rows | ~50 | ~300K (personalities + versions + experience) |
| Opus API calls | 10-50/day | 100-1000/day (batch warming) |
| RPC calls | ~100/day | ~200K/day (batch derivation) |
| IPFS fetches | ~50/day | ~100K/day (batch, cacheable) |
| R2 storage | ~1MB | ~800MB (100K BEAUVOIR docs) |

---

## Migration Path

1. **Now (soft launch):** Pre-compute 5 test personalities, on-demand synthesis for cold cache
2. **Month 1:** Add batch fingerprint derivation cron job
3. **Month 2:** Add BullMQ synthesis queue, cache warming for top 1000
4. **Month 3:** Add archetype template fallback (Tier 3), monitoring dashboard
5. **Month 6:** Evaluate SQS migration if queue volume warrants it
