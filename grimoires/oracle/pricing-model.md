---
id: pricing-model
type: knowledge-source
format: markdown
tags: [architectural, philosophical]
priority: 19
provenance:
  source_repo: 0xHoneyJar/loa-finn
  generated_date: "2026-02-17"
  description: "Pricing model and economic design"
max_age_days: 90
---

# Pricing Model

## Tier Structure

### Free Tier (Public)

- **Access**: Anyone, no authentication required
- **Rate limit**: 5 requests/day per IP
- **Pool**: `cheap` (cost-optimized models)
- **Use case**: Exploration, evaluation, casual queries

### Authenticated Tier (API Key)

- **Access**: `dk_live_` prefixed API key
- **Rate limit**: 50 requests/day per key
- **Pool**: `cheap` (same as free, higher volume)
- **Use case**: Integration testing, regular usage

### finnNFT Tier (Token-Gated)

- **Access**: JWT with verified finnNFT ownership
- **Rate limit**: Based on tier (pro: 500/day, enterprise: unlimited)
- **Pool**: Based on tier
  - Pro: `cheap` + `fast-code` + `reasoning`
  - Enterprise: All pools including `architect`
- **Use case**: Production integration, premium features

## Cost Model

### Per-Request Economics

The system tracks costs at micro-USD precision:

```
cost_micro = prompt_tokens * input_price_per_token + completion_tokens * output_price_per_token
cost_cents = Math.ceil(cost_micro / 10_000)
```

### Oracle Specific Limits

| Parameter | Value | Env Var |
|-----------|-------|---------|
| Daily cost ceiling | $20.00 (2000 cents) | `FINN_ORACLE_COST_CEILING_CENTS` |
| Global daily cap | 200 requests | `FINN_ORACLE_DAILY_CAP` |
| Estimated cost per request | $0.50 (50 cents) | `FINN_ORACLE_ESTIMATED_COST_CENTS` |
| Max concurrent | 3 | `FINN_ORACLE_MAX_CONCURRENT` |

### Cost Reservation Flow

1. Before model invoke: `reserveCost(estimatedCostCents)` — reserves budget
2. If reservation denied (ceiling exceeded): return 503
3. After invoke: `release(actualCostCents)` — reconcile
4. On error: `release(0)` — full refund

### Conservation Invariant

The billing system maintains a conservation invariant:
```
sum(all_reservations) - sum(all_releases) = current_cost_counter
```

This ensures no money is created or destroyed through the rate limiting system. The `incrby` with negative values for refunds and clamping to prevent negative counters maintains this invariant.

## Revenue Flow

```
User Request → Finn (tracks cost_micro)
  → S2S JWT with reservation_id
  → Arrakis billing finalize endpoint
  → Settlement to billing contract
  → Revenue distribution
```

Every request's cost is attributable to a specific tenant, pool, and model. This enables per-tenant billing, per-pool cost analysis, and overall system economics visibility.
