# Cross-Repo Issue Map — Agent Memory Runtime + Storage Commitments

**Status:** Draft only. Do not implement before @deep-name review.

## Linked issues

| Repo | Issue | Role | Status |
|---|---|---|---|
| `loa-dixie` | #89 | **Parent** — research/product-context home | Open (this RFC consumes it as upstream) |
| `loa-hounfour` | #57 | **Protocol question** — shared schemas/contracts | Open; **must resolve before Finn implementation** |
| `loa-finn` | #155 | **Runtime proposal** — this RFC | Open; this directory is the planning packet |

## Cross-repo ownership map

| Repo | Impact | Why | Issue to open / track |
|---|---|---|---|
| `loa-main` | Possible | New eval suites for memory recall fidelity and commitment integrity. No skill/command changes expected. | Defer until first Finn shadow implementation lands. |
| `loa-hounfour` | **Required (first)** | Owns wire-format types: `MemoryArtifact`, `MemoryCommitment`, `AgentIdentity`, `AccessPolicy`, `ReputationEvent`, `ValidationRecord`, `StoragePointer`. | `loa-hounfour#57` (already open). |
| `loa-finn` | **Required** | Runtime distillation, storage adapters, commitment adapters, identity hooks, audit, budgets. | `loa-finn#155` (this RFC). |
| `loa-freeside` | Possible | Product-surface exposure: provenance UI, holder-gated decryption UX, transparency panels, Discord/TG surfaces. | Open after Hounfour schema lands; not needed for Finn shadow. |
| `loa-dixie` | Required (parent) | Product narrative, oracle/knowledge consumer, agent reputation product semantics. | `loa-dixie#89` (parent). |

## Dependency order

```text
1. loa-hounfour#57   — ratify shared schemas (or explicitly defer to consumer-local)
2. loa-finn#155      — Sprint 0: Jani runtime boundary review (this RFC)
3. loa-finn#155      — Sprint 1: shadow-mode runtime (only after #57 resolves)
4. loa-freeside / loa-dixie consumer integration
5. loa-main eval suites (memory recall + commitment integrity)
```

## What this RFC will NOT do

- Will not define any schemas locally in `loa-finn/schemas/` or anywhere else in this repo.
- Will not pre-empt `loa-hounfour#57` with a "Finn-internal type that we'll just promote later."
- Will not open a Freeside or Dixie integration PR before Hounfour ratification.
- Will not select a concrete chain.
- Will not select concrete decentralized storage providers (IPFS/Arweave/Ceramic/Tableland) as canonical. The runtime will define adapter slots; provider selection is a separate sprint.

## Cross-repo handoff format

When this RFC reaches implementation, each cross-repo touch must:

1. Reference `loa-hounfour#57` for any wire-format type used.
2. Reference `loa-finn#155` for runtime contract.
3. Reference `loa-dixie#89` for product framing.
4. Use draft PR titles prefixed `[DRAFT][PROPOSAL]` until @deep-name approves.
