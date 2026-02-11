# ADR-002: DERIVED Provenance Class

**Status**: Accepted
**Date**: 2026-02-11
**Context**: BridgeBuilder PR #56 Finding #4 — missing provenance class for aggregated/computed claims
**Supersedes**: None
**References**: ADR-001 (Provenance Taxonomy)

## Problem Statement

Claims about aggregated or computed properties — such as "The system has 8 modules across 5 layers" or "4 registered scheduler tasks" — are verifiable but don't reduce to a single `file:line` citation. They require counting, cross-referencing, or running a computation across multiple source locations.

Currently these claims are tagged `INFERRED`, which understates their reliability. An INFERRED claim about architectural behavior (e.g., "the system favors eventual consistency") is genuinely uncertain. But a DERIVED claim (e.g., "there are 4 scheduler tasks") is deterministically verifiable — you can count them. Conflating these two trust profiles weakens the provenance taxonomy's discriminating power.

## Decision

Add `DERIVED` as the 6th provenance class in the taxonomy established by ADR-001.

| Class | Meaning | Citation Required |
|-------|---------|-------------------|
| `DERIVED` | Claim verifiable by aggregation or computation across multiple code locations | Yes — multiple `file:line` citations OR a computation script reference |

### Validation Rule

A `DERIVED` paragraph must contain at least one of:

1. **Multiple citations**: Two or more backtick `file:line` references (indicating the claim is derived from cross-referencing multiple locations)
2. **Script reference**: A reference to a computation script (e.g., `provenance-stats.sh`, `extract-doc-deps.sh`, `generation-manifest.json`) that produces the claimed value

### Trust Classification

DERIVED counts equivalent to CODE-FACTUAL for the `trust_level` computation in `provenance-stats.sh`. Rationale: both classes represent verifiable, deterministic claims — the difference is citation cardinality (single-source vs multi-source), not epistemic certainty.

The updated trust ratio formula:

```
trust_ratio = (CODE-FACTUAL + DERIVED) / total_tagged_blocks
```

## Alternatives Considered

### Alternative A: Keep 5-Class Taxonomy (Status Quo)

**Pros**: Simpler — no tooling changes needed. INFERRED is "close enough" for computed claims.

**Cons**: Loses the distinction between genuinely uncertain inference and deterministically verifiable aggregation. A document with 10 DERIVED claims tagged as INFERRED appears less trustworthy than it actually is, distorting the trust_level computation and potentially misrouting models.

**Decision**: Rejected — the discriminating power gained justifies the additive complexity.

### Alternative B: Add COMPUTED as Synonym for DERIVED

**Pros**: "Computed" is more technically precise for script-output claims.

**Cons**: Creates a synonym where one class suffices. DERIVED is broader (covers both manual cross-reference counting and script outputs) and aligns with W3C PROV-O terminology (`prov:wasDerivedFrom`), which is the closest established provenance ontology.

**Decision**: Rejected — DERIVED is the better term. Single class, no synonyms.

### Alternative C: DERIVED as Sub-Class of CODE-FACTUAL

**Pros**: Avoids adding a new top-level class entirely. Could use `CODE-FACTUAL (derived)` annotation.

**Cons**: CODE-FACTUAL's validation rule (must contain backtick citation) is already well-defined. Overloading it with a different citation cardinality rule creates ambiguity. Better to keep classes orthogonal with distinct validation rules.

**Decision**: Rejected — clean class boundaries are more maintainable than overloaded classes.

## Consequences

### Tooling Changes Required

| Tool | Change |
|------|--------|
| `check-provenance.sh` | Add DERIVED to valid classes; add multi-citation validation rule |
| `provenance-stats.sh` | Add DERIVED counter; include in trust_level computation alongside CODE-FACTUAL |
| `provenance-spec.md` | Add DERIVED class documentation with examples |
| ADR-001 | Cross-reference to ADR-002 (no structural changes needed) |
| `check-agent-context.sh` | No change (DERIVED is a provenance class, not an AGENT-CONTEXT field) |

### For Documentation Authors

- Claims that aggregate across multiple code locations should be tagged DERIVED instead of INFERRED
- The multi-citation requirement forces authors to provide the evidence trail for computed claims
- Example upgrade candidates: module counts, layer counts, task enumerations, configuration summaries

### For Trust Computation

- Documents with many DERIVED claims will see their trust_level increase (previously dragged down by INFERRED tagging)
- This more accurately reflects the document's actual verifiability

### For Multi-Model Routing

- DERIVED paragraphs signal "structured data extraction" workloads, potentially suitable for code-focused models that excel at counting and cross-referencing
