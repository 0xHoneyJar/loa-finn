# ADR-001: Provenance Taxonomy for AI-Generated Documentation

**Status**: Accepted
**Date**: 2026-02-11
**Context**: BridgeBuilder PR #55 Finding 1 — design rationale for provenance classification

## Problem Statement

AI-generated technical documentation needs a trust classification system that allows readers, reviewers, and downstream agents to assess the epistemic basis of each claim. Without explicit provenance, consumers cannot distinguish between verified code-grounded facts and reasonable inferences, leading to either blanket distrust or uncritical acceptance.

## Decision

Adopt a **5-class provenance taxonomy** applied at the paragraph level via HTML comment tags:

| Class | Meaning | Citation Required |
|-------|---------|-------------------|
| `CODE-FACTUAL` | Claim verifiable against source code | Yes — `file:line` backtick citation |
| `INFERRED` | Reasonable inference from code patterns | No (but encouraged) |
| `OPERATIONAL` | Deployment, configuration, or workflow guidance | No |
| `EXTERNAL-REFERENCE` | Claim sourced from external documentation or research | Yes — URL or paper reference |
| `HYPOTHESIS` | Exploratory or speculative claim | No (requires epistemic marker prefix) |

### Tag Format

```markdown
<!-- provenance: CODE-FACTUAL -->
The WAL rotation threshold is 10MB (`src/persistence/wal.ts:42`).
```

### Coverage Requirement

The `check-provenance` quality gate requires ≥95% of content paragraphs to carry a provenance tag. Non-taggable elements (headings, tables, code blocks, frontmatter) are excluded from the count.

### Per-Class Validation Rules

- **CODE-FACTUAL**: Must contain at least one backtick `file:line` citation (enforced by `check-provenance.sh`)
- **HYPOTHESIS**: Must begin with an epistemic marker: "We hypothesize", "We are exploring", "We believe", "Early evidence suggests", "It is plausible"
- **EXTERNAL-REFERENCE**: Must contain a URL (`https://`) or academic citation (`(Author, Year)`)
- **INFERRED** and **OPERATIONAL**: No additional structural requirements

### Threshold Calibration

The `trust_level` field in AGENT-CONTEXT v2 is computed from the ratio of CODE-FACTUAL blocks to total tagged blocks. Three thresholds partition documents into trust tiers:

**High (≥0.90)**: Module docs with >90% CODE-FACTUAL (gateway, persistence, cron) have zero INFERRED-only behavioral claims — all quantitative statements are citation-grounded to specific `file:line` references. This threshold captures the natural cluster of documents where nearly every paragraph has a direct code citation, making them suitable for code-focused model routing.

**Medium (≥0.60)**: The 0.60 boundary is where documents begin containing substantial architectural inference — INFERRED claims about system behavior, design rationale, and cross-module interactions that aren't reducible to single code citations. Documents like SECURITY.md, architecture.md, operations.md, and hounfour.md fall here. They mix code-grounded facts with reasoned architectural claims that require different verification strategies.

**Low (<0.60)**: Documents dominated by operational guidance or inference where CODE-FACTUAL is structurally impossible — README, CHANGELOG, index docs. Deployment instructions, version history, and navigation content don't reference specific code lines because they describe workflow and process, not code behavior. These documents are low-CODE-FACTUAL by design, not by deficiency.

**Calibration note**: These thresholds are initial values derived from observing the natural distribution across 16 documents in the first corpus generation (cycle-010 through cycle-014). They are subject to recalibration as the corpus grows and provenance patterns stabilize. The approach parallels Netflix's content quality scoring, where initial thresholds are set from observed distributions and refined through operational experience rather than theoretical modeling.

## Recalibration Protocol

Thresholds are living parameters, not fixed constants. As the corpus grows and provenance patterns evolve, the thresholds should be periodically reviewed and adjusted. This protocol defines a structured 4-step process for threshold recalibration, inspired by Google SRE's quarterly SLO review practice.

### Step 1: Observation

Run `provenance-stats.sh --json` across the full corpus (via `provenance-history.sh`) and examine the trust_level distribution. Note any documents that cluster near threshold boundaries — these are the most sensitive to threshold changes.

### Step 2: Distribution Analysis

Plot or tabulate `code_factual_ratio` for all documents. Look for:
- **Natural clusters**: Groups of documents with similar ratios that should share a trust_level
- **Boundary cases**: Documents within ±0.05 of a threshold that may be misclassified
- **New document types**: Documents added since the last calibration that don't fit existing clusters

### Step 3: Anomaly Detection

Identify anomalies that suggest threshold drift:
- A module doc with 85% CODE-FACTUAL classified as "medium" when other module docs are "high"
- An operational doc classified as "low" when its ratio improved through citation work
- INFERRED breakdown showing high `upgradeable` counts — indicating the corpus is ready for a CODE-FACTUAL push

### Step 4: ADR Amendment

If thresholds need adjustment:
1. Update `ground_truth.provenance.thresholds` in `.loa.config.yaml`
2. Re-run `provenance-stats.sh` across the corpus to verify the new distribution
3. Add an entry to the Recalibration History table below
4. If the change is significant (>0.10 shift), update this ADR's Threshold Calibration section with new rationale

### Recalibration History

| Date | Reviewer | Thresholds Changed | Rationale |
|------|----------|--------------------|-----------|
| 2026-02-11 | cycle-015 | Initial calibration (high=0.90, medium=0.60) | Observed distribution across 16 documents in cycles 010-014 |

## Alternatives Considered

### Alternative A: 3-Class Taxonomy (True / Uncertain / Opinion)

**Pros**: Simpler mental model, lower annotation burden.

**Cons**: Collapses the operational/external distinction. Operations docs (deployment steps, configuration) are neither "true" in the code-verifiable sense nor "uncertain" — they're procedural knowledge with a different trust basis. Similarly, external references have a clear provenance trail that "uncertain" obscures. This forces a false binary on claims that have legitimate but different evidence types.

**Decision**: Rejected — loses critical distinctions needed for agent routing.

### Alternative B: 7+ Class Taxonomy with Bayesian Confidence Scores

**Pros**: Maximum expressiveness. Could encode P(correct | evidence) per claim.

**Cons**: Requires calibration data we don't have. A confidence score of 0.85 is meaningless without a calibration set showing that 85% of claims tagged 0.85 are actually correct. This creates a precision theater problem where numbers look authoritative but carry no statistical validity. Additionally, the annotation burden per paragraph becomes prohibitive for a documentation pipeline that needs to scale to 16+ documents.

**Decision**: Rejected — calibration requirements make this impractical; adds complexity without actionable improvement over the 5-class system.

### Alternative C: Flat Tag-per-Sentence Granularity

**Pros**: Maximum precision — every sentence individually classified.

**Cons**: Extremely high annotation density makes documents unreadable in raw markdown. Most paragraphs contain claims of uniform provenance (a code-factual paragraph about a function rarely contains a hypothesis mid-sentence). The maintenance burden is 3-5x higher with minimal information gain.

**Decision**: Rejected — paragraph-level tagging provides the right cost/precision tradeoff.

## Consequences

### For Documentation Authors (Agents)
- Every content paragraph must be tagged before the document passes quality gates
- CODE-FACTUAL claims require locating the source code line — this forces grounding
- The taxonomy prevents "hallucination laundering" where inferred claims masquerade as facts

### For Multi-Model Routing (AGENT-CONTEXT v2)
- The `trust_level` field (high/medium/low) is derived from the ratio of CODE-FACTUAL blocks to total tagged blocks (computed by `provenance-stats.sh`)
- Models optimized for reasoning can be routed to high-inference documents, while code-focused models handle high-CODE-FACTUAL documents
- The `model_hints` field in AGENT-CONTEXT v2 uses provenance distribution to suggest optimal model types

### For Quality Gates
- `check-provenance.sh` validates tag coverage (≥95%) and per-class rules
- `provenance-stats.sh` computes per-class counts and trust_level deterministically
- Both scripts share the same awk-based paragraph detection state machine for consistency

### For Downstream Consumers
- Readers can filter by provenance class (e.g., "show me only CODE-FACTUAL paragraphs")
- CI/CD pipelines can enforce that API reference docs maintain >90% CODE-FACTUAL
- Audit trails are possible: any claim can be traced to its evidence type
