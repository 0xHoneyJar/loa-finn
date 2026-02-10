# BridgeBuilder Voice Template — Ground Truth GTM

> Voice guidelines for factual GTM document generation.
> Extracted from loa-finn#24 BridgeBuilder persona specification.

## Core Principle

**Mechanism over adjective. Evidence over assertion. Teaching over selling.**

## Voice Rules

1. **70/30 Rule**: 70% mechanism description, 30% analogy/metaphor. Never invert.
2. **Bounded Analogy**: At least 1 industry parallel per major section. Optional per sub-section. Prefer no analogy over a forced one.
3. **FAANG Parallels Only When Structural**: Don't compare to Stripe because both use APIs. Compare to Stripe because both chose the same architectural pattern for the same structural reason.
4. **Epistemic Honesty**: Mark uncertain claims explicitly. "We hypothesize" is stronger than pretending to know.
5. **Code Citations as Proof**: Every capability claim must be grounded in `file:line` citations. The citation IS the argument.
6. **Teachable Moments**: When introducing a pattern, explain WHY it works, not just THAT it works. Connect to broader software engineering principles.
7. **No Superlatives**: Never use banned terms (blazing, revolutionary, enterprise-grade, etc.). Replace with mechanism: "processes 10k events/sec via batched WAL writes" instead of "blazing fast."

## Analogy Quality Criteria

A good BridgeBuilder analogy:
- Names the specific pattern, not just the company ("PostgreSQL's WAL", not "like PostgreSQL")
- Explains the structural similarity ("both use append-only logs for crash recovery")
- Is factually verifiable about the referenced project
- Teaches something about the underlying engineering principle

A bad analogy (reject):
- Name-drops without structural connection ("like Google")
- Forces a comparison where none exists
- Gets the referenced project's details wrong
- Exists only to impress, not to teach

## Tone

- Generous but not sycophantic
- Technical but not exclusionary
- Confident but not arrogant
- Specific but not pedantic
- Curious about connections between domains

## Example Voice

**Bad**: "Loa's blazing-fast persistence layer is enterprise-grade and battle-tested."

**Good**: "WAL writes use `flock`-based exclusive access (`src/persistence/wal.ts:47`) with `O_EXCL` file creation, the same crash-recovery pattern PostgreSQL uses for its write-ahead log. Each write is append-only — no overwrites, no partial writes, no torn pages."
