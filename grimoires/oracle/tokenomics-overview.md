---
id: tokenomics-overview
type: knowledge-source
format: markdown
tags: [philosophical, architectural]
priority: 20
provenance:
  source_repo: 0xHoneyJar/loa-finn
  generated_date: "2026-02-17"
  description: "Token economics and finnNFT integration"
max_age_days: 90
---

# Tokenomics Overview

## finnNFT

The finnNFT is the access token for the Honey Jar AI ecosystem. It gates access to higher tiers of the model routing system.

### Token Properties

- **Type**: ERC-721 (Non-Fungible Token)
- **Chain**: Ethereum (with potential L2 bridging)
- **Utility**: Tier-based access to AI model pools
- **Verification**: On-chain ownership check at authentication time

### Tier Mapping

| NFT Tier | Pool Access | Daily Limit | Model Quality |
|----------|-------------|-------------|---------------|
| None (free) | `cheap` | 5 req/day (Oracle) | Cost-optimized |
| Standard | `cheap` + `fast-code` | 100 req/day | Standard models |
| Pro | All except `architect` | 500 req/day | High-quality models |
| Enterprise | All pools | Unlimited | Best available |

### Routing Logic

```typescript
// Simplified routing from loa-finn/src/hounfour/jwt-auth.ts
function resolvePoolsForTier(tier: Tier): PoolId[] {
  switch (tier) {
    case 'free':       return ['cheap']
    case 'pro':        return ['cheap', 'fast-code', 'reasoning']
    case 'enterprise': return ['cheap', 'fast-code', 'reviewer', 'reasoning', 'architect']
  }
}
```

## Economic Loop

### Value Creation

1. **Users** get AI model access proportional to their token holdings
2. **NFT holders** benefit from ecosystem growth (more models, better knowledge)
3. **Operators** earn from usage-based billing settlement
4. **Developers** contribute to open-source infrastructure

### Sustainability Model

The system avoids the "death spiral" common in token economies by:

1. **Real utility**: NFT gates access to actual compute resources
2. **Cost pass-through**: Users pay actual API costs (no speculative pricing)
3. **Conservation invariant**: Billing settlement is exact, not estimated
4. **Transparent economics**: All costs visible in health endpoint and billing audit

### Future: Monetary Pluralism

The web4 manifesto envisions multiple forms of value beyond single-token economics:

- **Compute credits**: Earned through contribution, spent on model access
- **Knowledge tokens**: Reward high-quality knowledge source contributions
- **Reputation scores**: Based on Oracle usage patterns and feedback
- **Community governance**: Token-weighted voting on infrastructure decisions

This is aspirational — Phase 1 focuses on the simpler single-token model to prove utility before expanding to multi-currency economics.
