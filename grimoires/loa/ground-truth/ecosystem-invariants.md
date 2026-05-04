---
title: loa-finn — Cross-Repo Invariant Index
version: 1.0.0
last_updated: 2026-02-28
commit: b4a3075
---

# Cross-Repo Invariant Index

> Federation seed — maps invariants across the HoneyJar ecosystem.
> Each cross-reference includes repo + file path for verification.

<!-- provenance: CODE-FACTUAL -->
<!-- evidence: file=grimoires/loa/ground-truth/contracts.yaml -->

## loa-finn (this repo)

36 invariants across 10 domains. See [contracts.yaml](contracts.yaml) for machine-readable format.

| Domain | Count | Key Invariants |
|--------|-------|----------------|
| billing | 6 | INV-1 (completeness), INV-3 (idempotency), INV-5 (bounded retry) |
| wal | 5 | WAL-SEQ (monotonic), WAL-AUTH (authoritativeness) |
| auth | 5 | AUTH-ES256 (production enforcement), AUTH-JTI (replay protection) |
| economic_boundary | 3 | EB-TIER (tier-to-trust mapping) |
| audit_chain | 4 | AUDIT-CHAIN (chain-bound hash integrity) |
| dlq | 3 | DLQ-DELIVERY (at-least-once) |
| concurrency | 3 | CONC-LOCK (entry-level locking) |
| credits | 2 | CREDIT-SUM (sum conservation) |
| recovery | 3 | REC-MODES (strict/degraded/clean) |
| circuit_breaker | 2 | CB-FSM (3-state machine) |

## Hounfour Protocol (@0xhoneyjar/loa-hounfour)

73 constitutional constraint files in the constraint expression DSL.

| Category | Constraint Files | Schema URI Pattern |
|----------|------------------|--------------------|
| Economy | `BillingEntry`, `JwtClaims`, `S2SJwtClaims`, `EconomicBoundary` | `economy/*.constraints.json` |
| Governance | `ScoringPath`, `ReputationEvent`, `TaskTypeCohort` | `governance/*.constraints.json` |
| Constraints DSL | Expression grammar v2.0, type checker, evaluator | `constraints/` module |

### Cross-references to loa-finn

| loa-finn Invariant | Hounfour Enforcement | Relationship |
|---------------------|---------------------|--------------|
| INV-4 (cost immutability) | `BillingEntry.constraints.json` | Protocol-level cost field validation |
| AUTH-ES256 (production algo) | `JwtBoundarySpec` schema | Algorithm allowlist from protocol |
| AUTH-JTI-MERGE (effective policy) | `PROTOCOL_JTI_POLICY` export | Stricter-wins merge semantics |
| EB-TIER (tier-to-trust) | `REPUTATION_STATES` vocabulary | Tier mapping validated against protocol states |
| AUDIT-CHAIN (chain-bound hash) | `computeChainBoundHash()` | Hash computation from protocol-types.ts |

## Dixie (documentation intelligence)

4 verification invariants for document quality.

| ID | Name | Enforcement |
|----|------|-------------|
| INV-009 | Freshness | Citations must reference code from current commit |
| INV-010 | Citation Integrity | Every `file:line` citation must resolve to existing content |
| INV-011 | Chain Integrity | Provenance history forms a hash chain |
| INV-012 | Three-Witness | Claims require CODE-FACTUAL + test + review evidence |

### Cross-references to loa-finn

| Dixie Invariant | loa-finn Analog | Relationship |
|-----------------|-----------------|--------------|
| INV-009 (freshness) | `gt-staleness-check.sh` | Both detect stale citations; Dixie uses commit-level, loa-finn uses file-level |
| INV-010 (citation) | `gt-drift-check.sh` | Both verify citations resolve; Dixie is stricter (line-level content match) |
| INV-011 (chain) | AUDIT-CHAIN | Both use hash chains; Dixie for docs, loa-finn for audit trail |

## Freeside (credit system)

5 conservation guard invariants.

| ID | Name | Enforcement |
|----|------|-------------|
| I-1 | Lot Sum | `allocated + unlocked + reserved + consumed + expired = initial` |
| I-2 | No Negative Balances | All partition values ≥ 0 |
| I-3 | Atomic Transitions | State changes within DB transaction |
| I-4 | Nonce Uniqueness | Used nonces tracked with TTL |
| I-5 | Allocation Immutability | `initial_allocation` never modified after creation |

### Cross-references to loa-finn

| Freeside Invariant | loa-finn Analog | Relationship |
|--------------------|-----------------|--------------|
| I-1 (lot sum) | CREDIT-SUM | Same conservation law; loa-finn enforces via SQL CHECK + `verifyConservationSQL()` |
| I-4 (nonce uniqueness) | CREDIT-NONCE | Same pattern; loa-finn uses `finn_used_nonces` table with TTL cleanup |
| I-5 (allocation immutability) | INV-4 (cost immutability) | Analogous set-once pattern; different domains (credits vs billing) |

## Federation Status

| Repo | Invariants | Machine-Readable | Cross-Referenced |
|------|-----------|------------------|-----------------|
| loa-finn | 36 | contracts.yaml | This document |
| loa-hounfour | 73 | *.constraints.json | Partial (5 links) |
| dixie | 4 | Not yet | Partial (3 links) |
| freeside | 5 | Not yet | Partial (3 links) |

**Next step**: Each repo publishes a `contracts.yaml` (or equivalent) with stable IDs, enabling automated cross-repo consistency verification.
