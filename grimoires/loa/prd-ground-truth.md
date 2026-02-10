# Product Requirements Document: Ground Truth — Factual GTM Skill Pack

> **Version**: 1.1.0
> **Date**: 2026-02-10
> **Author**: @janitooor (via BridgeBuilder voice)
> **Status**: Draft
> **Voice**: BridgeBuilder persona (loa-finn#24)
> **Related**: loa#247 (Meeting Geometries), loa-finn#24 (BridgeBuilder)
> **Grounding**: Codebase analysis (24,886 lines TypeScript), 17 skills, 5 architecture layers

---

## 1. Problem Statement

### The Problem

Developer tools projects fail at go-to-market in one of two ways:

1. **The Silent Cathedral**: Exceptional engineering that nobody outside the team understands. The codebase is a marvel — write-ahead logging, multi-model adversarial review, compound learning cycles — but the only documentation is internal PRDs and SDDs written for the people who already know. Google's MapReduce existed for two years as internal infrastructure before the paper that launched an industry. Most projects never write the paper.

2. **The Buzzword Factory**: Marketing-first materials that developers distrust on contact. "Blazing fast." "Revolutionary AI." "Enterprise-grade." These are adjective-driven claims with no mechanism behind them. When Vercel publishes benchmark results, they include methodology, iteration counts, and raw data. When most projects claim "fast," they show a cherry-picked demo. Developers can smell the difference.

What's missing is the middle path: **factual, mechanism-driven documentation that describes what the system actually does, grounded in code reality, using accessible analogies to make complex concepts understandable.** The raw materials from which marketing can build, developers can form informed conclusions, and users can understand capabilities without being sold to.

> **The BridgeBuilder framing**: Stripe doesn't sell payment processing — they ship documentation so good that developers build the integration before procurement approves the vendor. Stripe's docs are the product's primary sales tool, and they work precisely because they are not salesy. Features are not shipped until documentation is written and reviewed. Documentation quality is a performance review criterion. The result: "time to first API call" became the metric that defined an industry. We need the equivalent for agent frameworks.

### Why Now

- **loa-finn has reached critical mass**: 24 sprints completed, 17 skills, production deployment, multi-model orchestration, autonomous PR review, 3-tier persistence. There is real engineering to describe.
- **The BridgeBuilder persona exists**: Issue #24 defines a voice that is simultaneously rigorous and generous — FAANG analogies, teachable moments, metaphors for laypeople. This voice is already implemented in the review pipeline. It should also tell the story.
- **The LLM Cambrian Explosion demands differentiation through truth**: Hundreds of agent frameworks are competing. Most will not survive the Ordovician. Like the transition from Cambrian external armor (flashy features, impressive demos) to vertebrate internal skeleton (persistence, recovery, compound learning), the projects that endure will be the ones with genuine architectural depth — and the ones that can articulate that depth factually.
- **Issue #247 opens a deeper question**: The meeting geometries work (séance, trip, rave/melt protocols) reveals that this project is operating at an intersection of engineering and something more — cultural theory, biological models, indigenous knowledge systems. Factual documentation of this intersection is itself a differentiator. No other agent framework is thinking about Black Queen Hypothesis dynamics in multi-agent systems, or about how Ostrom's commons governance applies to shared agent resources.

### Vision

**A skill pack that reads the codebase, maps capabilities to verifiable claims, frames them through the BridgeBuilder voice, and produces tiered factual documents that let the engineering speak for itself.**

The analogy: Rust doesn't say "safe concurrency." Rust says "the ownership and type systems are a powerful set of tools to help manage memory safety and concurrency problems" and then the compiler proves it. "Fearless Concurrency" is a capability framing backed by a compiler guarantee, not a marketing phrase. We need the equivalent: capability framings backed by code citations.

---

## 2. Goals & Success Metrics

### Primary Goals

| ID | Goal | Priority |
|----|------|----------|
| G-1 | Generate factual capability documents grounded in code reality (`file:line` citations) | P0 |
| G-2 | Use BridgeBuilder voice for FAANG analogies, metaphors, and teachable moments | P0 |
| G-3 | Produce documents that marketing departments can build on without distortion | P0 |
| G-4 | Enable developers evaluating the framework to form evidence-based conclusions | P1 |
| G-5 | Document the deeper theoretical foundations (meeting geometries, biological models) factually | P1 |
| G-6 | Maintain document freshness through codebase grounding on each generation | P1 |
| G-7 | Support multi-repo generation (loa, loa-finn, loa-beauvoir) | P2 |

### Claim Taxonomy

Every statement in a generated document is classified by provenance:

| Class | Definition | Citation Rule | Example |
|-------|-----------|---------------|---------|
| **CODE-FACTUAL** | A claim about what the codebase does or contains | MUST cite `file:line` — 100% required | "WAL writes use flock-based exclusive access" |
| **REPO-DOC-GROUNDED** | A claim derived from project documentation (PRD, SDD, decisions.yaml) | MUST cite source document and section | "The design chose WAL over in-memory because..." |
| **ISSUE-GROUNDED** | A claim derived from GitHub issue discussions | MUST cite issue number and comment | "Eileen's Black Queen observation (#247)" |
| **ANALOGY** | A FAANG/bluechip parallel or metaphor | NO code citation required; must be factually accurate about the referenced project | "PostgreSQL uses the same WAL pattern" |
| **HYPOTHESIS** | A research-stage claim about theoretical foundations | MUST be prefixed with epistemic marker ("we are exploring," "we hypothesize") and cite source | "We hypothesize that Black Queen dynamics apply to..." |
| **EXTERNAL-REFERENCE** | A factual assertion about something outside this project | MUST cite external source (URL, paper, book) or be removed | "Ostrom won the Nobel Prize in 2009" |

### Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| CODE-FACTUAL citation rate | 100% of code-factual claims cite `file:line` | Automated scan: regex match for `file:line` patterns per code-factual paragraph |
| Banned-claim lexicon pass rate | 0 banned terms in output | Automated scan against banned list: "blazing," "revolutionary," "enterprise-grade," "cutting-edge," "world-class," "game-changing," "next-generation" |
| Mechanism anchor density | Every capability section contains at least one "does X by Y" pattern with a code citation | Automated pattern match |
| Document staleness | <7 days from last codebase change | Generation timestamp vs HEAD SHA comparison |
| Capability coverage | 100% of top-level capabilities documented in Capability Brief | Curated capability taxonomy (persistence, orchestration, review, learning, scheduling, identity) checked against output |
| Feature inventory coverage | >90% of `src/` top-level modules present in Feature Inventory | Module directory listing vs inventory entries |
| BridgeBuilder voice presence | At least 1 high-confidence industry parallel per major section | Automated section scan; analogies are optional per sub-section and must not be forced |

### Non-Goals (Explicit)

- This skill pack does NOT generate marketing copy, taglines, or promotional materials
- This skill pack does NOT make comparative claims against competitors (honest comparison documents state facts about *this* system, not claims about others)
- This skill pack does NOT generate documentation for features that don't exist yet (roadmap items are explicitly marked as such)
- This skill pack does NOT replace the existing PRD/SDD workflow — it operates downstream of it

---

## 3. User & Stakeholder Context

### Primary Persona: The Evaluating Developer

**Name**: Alex (Senior Engineer at a Web3 protocol)
**Role**: Evaluating agent frameworks for their team's infrastructure
**Needs**: Understand what loa-finn actually does, how it works architecturally, what tradeoffs were made, and whether the engineering is production-grade. Wants to read code-grounded documentation, not landing pages.
**Pain points**: Every framework claims to be "the best." None of them show the architecture. Alex wants the equivalent of reading the K8s architecture.md before committing to a container orchestrator.

### Secondary Persona: The Marketing Lead

**Name**: Sam (Developer Relations / Marketing)
**Role**: Creating public-facing materials about the project
**Needs**: Factual raw materials they can shape into blog posts, landing pages, and conference talks without making things up. Quantified capabilities, named architectural patterns, industry parallels.
**Pain points**: Engineering won't write marketing docs. Marketing can't read the codebase. The gap between what the system does and what the public materials say is a credibility risk.

### Tertiary Persona: The Contributor

**Name**: Rio (Open source contributor)
**Role**: Considering contributing to the project
**Needs**: Architecture overview, design principles, decision rationale. Wants to understand *why* things are built this way before submitting PRs. The Linux kernel's development-process.md equivalent.
**Pain points**: Most open source projects have READMEs that describe installation but not architecture. Rio wants the "Thinking in Loa" document.

### Quaternary Persona: The Researcher

**Name**: Eileen (AI systems researcher)
**Role**: Studying multi-agent collaboration, agentic architectures, bio-inspired computing
**Needs**: Documentation of the deeper theoretical foundations — meeting geometries, Black Queen Hypothesis applications, compound learning as evolutionary pressure. Wants factual descriptions of how these theories inform implementation decisions.
**Pain points**: Novel theoretical work is often buried in GitHub issue comments (like #247) rather than structured for research consumption.

---

## 4. Functional Requirements

### 4.1 Core Skill: `/ground-truth`

A composite skill that generates factual GTM documents from codebase reality. Invocable as a single command with document-type flags.

```bash
# Generate all document types
/ground-truth

# Generate specific document types
/ground-truth --capability-brief
/ground-truth --architecture-overview
/ground-truth --feature-inventory
/ground-truth --thinking-in-loa
/ground-truth --tradeoffs
/ground-truth --release-narrative v1.31.0
/ground-truth --research-brief
```

### 4.2 Document Types

#### 4.2.1 Capability Brief (The "What We Actually Do" Document)

**Pattern source**: HashiCorp "What is Terraform" + Vercel case studies

Generates a mechanism-driven capability description. Every capability is:
- Described by what it does (mechanism), not what it is (adjective)
- Cited to specific source files and line numbers
- Accompanied by a BridgeBuilder FAANG analogy
- Framed through a use case (when you'd want this)

**Example output fragment**:
```markdown
### Persistence: Write-Ahead Logging

**What it does**: Every state mutation is written to an append-only JSONL
log before being applied. If the process crashes mid-operation, state is
recovered by replaying the log from the last checkpoint.

**Code**: `src/persistence/wal.ts:47-89` — WAL write path with flock-based
exclusive access. `src/persistence/recovery.ts:12-45` — three-mode recovery
cascade (strict → degraded → clean).

**Industry parallel**: This is the same pattern PostgreSQL uses for crash
recovery. When Postgres writes a row, it hits the WAL first, then the
heap. If the server loses power between the two, the WAL replays on
startup. loa-finn applies this proven database pattern to agent state —
every conversation turn, every learning, every tool invocation is journaled
before it's committed. Maximum data loss on crash: 30 seconds (the sync
interval).

**Use case**: You're running an autonomous agent overnight. At 3am, the
Railway instance restarts for a platform update. When the process comes
back, the agent resumes exactly where it left off — mid-conversation,
mid-task, with full context. No human intervention needed.
```

#### 4.2.2 Architecture Overview (The "How It Works" Document)

**Pattern source**: K8s architecture.md + Linux kernel subsystem docs

Generates a component-level architecture document describing:
- The 5-layer architecture (Gateway → Agent → Identity → Persistence → Scheduler)
- Unidirectional dependency rules and why they exist
- Data flow diagrams described in text (mermaid-compatible)
- Design principles with rationale
- Prior art acknowledgment (what we learned from, what we improved)

**BridgeBuilder voice requirement**: Each architectural decision is accompanied by a FAANG/bluechip OSS parallel explaining *why this pattern works at scale*.

#### 4.2.3 Feature Inventory (The "Complete Honest Matrix")

**Pattern source**: K8s Operator Feature Matrix + Rust edition compatibility

Generates a structured inventory of every feature with fields constrained to what is computationally derivable:

| Field | Source | How Computed |
|-------|--------|-------------|
| **Status** | Curated `features.yaml` registry (maintained by team) | Manual classification: stable / beta / experimental / planned |
| **Entry point** | Static analysis of `src/` directory structure | Top-level module + primary export |
| **Test presence** | Grep for test files referencing the entry point | Count of `*.test.ts` / `*.spec.ts` files importing or referencing the module |
| **Static dependencies** | Import graph analysis | `import` / `require` statements from entry point (internal + package.json deps) |
| **Known limitations** | Explicit sources only: `TODO`/`FIXME` tags in source, entries in `limitations.yaml` registry, issue labels | Automated extraction + curated registry; never inferred or fabricated |

**Required registry file**: `grimoires/loa/ground-truth/features.yaml` — curated by the team, containing status classifications and any limitations not encoded in source code. The generator reads this file; it does not invent status or limitation data.

```markdown
| Feature | Status | Entry Point | Tests | Deps | Limitations |
|---------|--------|-------------|-------|------|-------------|
| WAL Persistence | Stable | `src/persistence/wal.ts` | 3 test files | flock, ulid | `TODO:wal.ts:92` — Single-writer only |
| R2 Sync | Stable | `src/persistence/r2-sync.ts` | 2 test files | @aws-sdk/client-s3 | `limitations.yaml` — S3 compat untested |
| Multi-Model Orchestration | Beta | `src/hounfour/ensemble.ts` | 1 test file | hono | `FIXME:ensemble.ts:45` — No Gemini adapter |
| BridgeBuilder Review | Beta | `src/bridgebuilder/entry.ts` | 3 test files | gh CLI | Policy: COMMENT only, cannot APPROVE |
```

#### 4.2.4 "Thinking in Loa" (The Mental Model Document)

**Pattern source**: React's "Thinking in React" + Rust's "Fearless Concurrency"

Generates a conceptual guide that teaches the paradigm:
- What problem does Loa solve? (Not "AI agents" — the specific architectural problem)
- The three-zone model as a thinking tool
- Why beads-first matters (universal state machine)
- The compound learning loop as the core innovation
- How the meeting geometries (#247) represent a genuine research frontier

**Critical requirement**: This document must be accessible to someone who has never used an AI agent framework. The metaphors should make the concepts graspable. The BridgeBuilder voice excels here — "This mutex is like a bathroom door lock — it works, but imagine 10,000 people in the hallway."

#### 4.2.5 Tradeoffs & Fit Assessment (The "Honest Self-Assessment" Document)

**Pattern source**: Rust RFC drawbacks sections + K8s compatibility matrices

Generates a self-assessment document structured around internal capability axes. **Hard rule: no competitor rows, no competitor names, no comparative claims about other frameworks.** Only statements about this system's own properties.

Axes are limited to internal dimensions:
- Scaling model (single-instance vs distributed)
- Persistence guarantees (durability, recovery modes)
- Provider support (which LLM providers, which cloud services)
- Operational footprint (image size, resource requirements)
- Feature maturity (stable vs beta vs experimental)
- Security posture (audit results, safety mechanisms)

**Example**:
```markdown
### Where We're Strong (with evidence)
- **State recovery**: 3-tier cascade (WAL → R2 → Git) means agent state
  survives crashes, restarts, and redeployments.
  Code: `src/persistence/recovery.ts:12-45`
  Evidence: Tested across 24 sprint cycles in production.

### Where We're Not a Fit (today)
- **If you need horizontal scaling**: Single-instance architecture by design.
  Compound learning requires consistent state; distributed state introduces
  split-brain risk. (Decision: `grimoires/loa/decisions.yaml` — "single-writer")
- **If you need multi-provider agent loops**: Primary agent session is
  Anthropic-only. Multi-provider exists for Flatline review (Claude + GPT-5.2)
  but not for the core agent. (`src/agent/session.ts:23`)
```

#### 4.2.6 Release Narrative (The "What Changed and Why" Document)

**Pattern source**: Rust Edition Guide + Vercel blog technical deep dives

Generates per-release capability summaries with:
- New capabilities described by mechanism
- Migration guidance for breaking changes
- FAANG parallels for significant new features
- Performance/metric changes with methodology

#### 4.2.7 Research Brief (The "Deeper Foundations" Document)

**Pattern source**: Google Research blog + Santa Fe Institute working papers

Generates structured documentation of the project's theoretical foundations:
- Meeting geometries (séance, trip, melt) as multi-model collaboration paradigms
- Black Queen Hypothesis applications to multi-agent resource sharing
- Compound learning as evolutionary pressure on agent behavior
- Autopoietic systems theory applied to self-maintaining agent architectures
- Ostrom's commons governance applied to shared agent resources
- Indigenous knowledge systems as models for long-lived information encoding

**Critical requirement**: These are treated as research hypotheses with honest epistemic status — "we are exploring X because Y suggests Z" not "we have solved X."

### 4.3 Generation Pipeline

Each document type follows the same pipeline:

```
1. GROUND    — Run /ride or use cached codebase reality (<7 days)
2. INVENTORY — Enumerate modules, features, tests from codebase
3. CITE      — Map every CODE-FACTUAL claim to file:line evidence
4. VOICE     — Apply BridgeBuilder persona (FAANG analogies, metaphors)
5. VERIFY    — MANDATORY citation verification (see §4.3.1)
6. OUTPUT    — Generate markdown with source citations and provenance tags
7. FRESHNESS — Stamp with generation date and codebase HEAD SHA
```

#### 4.3.1 Mandatory Verification (Non-Optional)

Verification is **mandatory for all P0 document types** (Capability Brief, Architecture Overview, Feature Inventory). This is non-negotiable because the entire value proposition depends on factual accuracy.

**Baseline verifier** (deterministic, always runs):
1. **File existence check**: Every cited `file:line` must reference a file that exists at HEAD
2. **Line range check**: Cited line ranges must contain referenced identifiers/strings (e.g., if the claim mentions "flock-based exclusive access," the cited lines must contain `flock`)
3. **Symbol extraction**: Claims linked to function/class/variable names must match exported symbols in the cited file
4. **Registry cross-check**: Feature Inventory entries must match `features.yaml` registry

**Adversarial verifier** (Flatline Protocol, optional additional pass):
- Cross-model review of document accuracy
- Enabled by default in autonomous mode; optional in interactive mode
- Failure in adversarial pass surfaces warnings, not blocks

If the baseline verifier fails, the generation **halts** and surfaces the specific broken citations for correction. Documents with unverified citations MUST NOT be emitted.

### 4.4 BridgeBuilder Voice Integration

The BridgeBuilder persona (loa-finn#24) provides the voice layer:

| Principle | Application in GTM Documents |
|-----------|------------------------------|
| **Teachable Moments** | Every architectural decision is framed as education |
| **FAANG Analogies** | "Google's Borg team faced this exact tradeoff..." |
| **Metaphors for Laypeople** | Complex concepts get accessible parallels |
| **Code as Source of Truth** | Every CODE-FACTUAL claim cites `file:line` |
| **Rigorous Honesty** | Limitations stated as clearly as strengths |
| **Agent-First Citizenship** | Decision trails documented for future agents |

**Analogy frequency rule**: At least 1 high-confidence industry parallel per major section of a document. Analogies are **optional per sub-section** and must pass an accuracy check: the referenced project/incident must be factually correct. **Prefer no analogy over a forced or inaccurate analogy.** This is a bounded rule, not a 100% mandate — the goal is enrichment, not saturation.

**Accuracy rubric for analogies**: Before including a FAANG/bluechip parallel, verify: (1) the referenced event/pattern actually happened as described, (2) the structural parallel to our system is genuine (not superficial), (3) the analogy illuminates rather than obscures. If any check fails, omit the analogy.

### 4.5 Environment Enrichment Protocol

Drawing from issue #247's exploration of knowledge production environments:

The skill pack should create conditions for the richest possible AI engagement when generating documents. This means:

1. **Rich context loading**: Before generation, load not just code but also:
   - Grimoire notes and learnings (`grimoires/loa/NOTES.md`)
   - Decision history (`grimoires/loa/decisions.yaml`)
   - Architecture decisions and their rationale
   - Issue discussions (#247, #24) as theoretical context
   - Compound learning patterns from `grimoires/loa/a2a/`

2. **Cross-domain reference sets**: Following the Shulgin Protocol pattern from #247, provide curated cross-domain reference sets that enable richer analogies:
   - Distributed systems literature (Borg, Omega, Mesos, Paxos)
   - Biological systems (mycorrhizal networks, immune systems, Black Queen)
   - Cultural systems (commons governance, knowledge encoding, ceremony)
   - Architectural history (cathedrals, bridges, vernacular architecture)

3. **Purpose framing**: The generation prompt should frame the work with genuine purpose — not "generate documentation" but "help people understand what we've built and why it matters, with the intellectual honesty of a Bell Labs technical report and the accessibility of Feynman's lectures."

#### 4.5.1 Provenance Model (Guardrail Against Enrichment Drift)

**Critical**: Enrichment context increases hallucination risk. To prevent rhetorically rich but factually ungrounded output, every paragraph in generated documents must be tagged with its provenance class (from the Claim Taxonomy in §2):

```markdown
<!-- provenance: CODE-FACTUAL -->
WAL writes use flock-based exclusive access (`src/persistence/wal.ts:47`).

<!-- provenance: ANALOGY -->
This is the same pattern PostgreSQL uses for crash recovery.

<!-- provenance: ISSUE-GROUNDED -->
Eileen observed that Black Queen dynamics map to multi-agent resource
sharing (loa#247, comment 2026-02-08).

<!-- provenance: HYPOTHESIS -->
We hypothesize that Ostrom's commons governance conditions apply to
shared agent resource pools.
```

**Rules**:
- Enrichment sources (cross-domain references, issue discussions, cultural theory) may ONLY influence ANALOGY, ISSUE-GROUNDED, and HYPOTHESIS paragraphs
- CODE-FACTUAL paragraphs must derive exclusively from codebase analysis — enrichment context is invisible to them
- No EXTERNAL-REFERENCE assertions without a citation (URL, paper DOI, or book reference)
- The baseline verifier (§4.3.1) validates provenance tags: CODE-FACTUAL paragraphs without `file:line` citations fail verification

---

## 5. Technical & Non-Functional Requirements

### 5.1 Skill Architecture

Built as a Loa skill following existing patterns:

```
.claude/skills/ground-truth/
├── SKILL.md              # Skill definition with frontmatter
├── resources/
│   ├── templates/        # Output templates per document type
│   ├── voice/            # BridgeBuilder voice guidelines
│   ├── analogies/        # Curated FAANG/bluechip analogy bank
│   └── cross-domain/     # Reference sets for enrichment
```

### 5.2 Codebase Grounding

- MUST use `/ride` output or equivalent codebase analysis
- MUST cite `file:line` for every factual claim about the codebase
- MUST include generation timestamp and codebase HEAD SHA
- SHOULD flag when generated document may be stale (>7 days)

### 5.3 Quality Gates

All gates are automated and mandatory for P0 document types:

| Gate | Check | Pass Criteria | Blocking? |
|------|-------|---------------|-----------|
| **Banned-claim lexicon** | Scan output for banned superlatives/adjectives | 0 matches against banned list (see §2 Success Metrics) | Yes — generation halts |
| **CODE-FACTUAL citation** | Every CODE-FACTUAL paragraph has `file:line` | 100% citation rate | Yes — generation halts |
| **File existence** | Every cited file exists at HEAD | 100% of cited paths resolve | Yes — generation halts |
| **Line content match** | Cited line ranges contain referenced identifiers | Referenced symbol/string found within cited range | Yes — generation halts |
| **Provenance tagging** | Every paragraph has a provenance class | 100% tagged | Yes — generation halts |
| **Honesty section** | Document includes "Limitations" / "Where We're Not a Fit" section | Section present and non-empty | Yes — generation halts |
| **Freshness stamp** | Document includes generation metadata (timestamp, HEAD SHA) | Metadata block present | Yes — generation halts |
| **Mechanism anchors** | Capability sections contain "does X by Y" + citation patterns | At least 1 per capability section | Warning — does not halt |
| **Analogy accuracy** | ANALOGY paragraphs reference verifiable projects/events | Spot-check (not automated; manual review in audit) | Warning — does not halt |

### 5.4 Output Format

- Markdown with GitHub-flavored extensions
- Mermaid diagrams for architecture visualizations
- Structured frontmatter for metadata
- Compatible with Docusaurus, MkDocs, or raw GitHub rendering

### 5.5 Integration Points

| Integration | Purpose |
|-------------|---------|
| `/ride` | Codebase reality grounding |
| `/review-sprint` | Verify document accuracy |
| BridgeBuilder persona | Voice and analogy layer |
| Flatline Protocol | Optional adversarial quality check |
| Beads | Track document generation as tasks |

---

## 6. Scope & Prioritization

### Existing Primitives (What We Already Have)

Before scoping work, enumerate what already exists and what is net-new:

| Primitive | Status | Location | Reusable? |
|-----------|--------|----------|-----------|
| `/ride` codebase analysis | Implemented | `.claude/skills/riding-codebase/SKILL.md` | Yes — outputs module inventory, dependency graph, code citations |
| BridgeBuilder persona definition | Defined | loa-finn#24 (issue), `grimoires/loa/prd-bridgebuilder.md` | Yes — voice principles extractable as prompt template |
| BridgeBuilder review pipeline | Implemented | `src/bridgebuilder/` | Partial — review pipeline exists but generates PR comments, not documents |
| Flatline Protocol | Implemented | `.claude/scripts/flatline-orchestrator.sh` | Yes — adversarial verification available |
| Grimoire decision trail | Active | `grimoires/loa/decisions.yaml`, `NOTES.md` | Yes — directly loadable as context |
| Banned-term scanning | Not implemented | — | Net-new (simple regex, low effort) |
| File existence / line-range verifier | Not implemented | — | Net-new (core infrastructure, moderate effort) |
| Provenance tagger | Not implemented | — | Net-new (output post-processor, moderate effort) |
| `features.yaml` registry | Not implemented | — | Net-new (curated file, low effort to create, ongoing maintenance) |
| `limitations.yaml` registry | Not implemented | — | Net-new (curated file, low effort) |
| Analogy bank | Not implemented | — | Net-new (curated reference library) |

### MVP (Sprint 1-2): Capability Brief + Full Verification

Sprint 1-2 delivers **one document type done right** rather than three done poorly. The Capability Brief is the highest-value artifact and proves the full pipeline.

**Sprint 1: Infrastructure + Capability Brief Draft**

| Deliverable | Priority | Description |
|-------------|----------|-------------|
| `features.yaml` + `limitations.yaml` registries | P0 | Curated by team; required input for all doc types |
| Baseline verifier | P0 | File existence check, line-range content match, symbol extraction |
| Provenance tagger | P0 | Post-processor that validates provenance class per paragraph |
| Banned-claim lexicon scanner | P0 | Regex-based scan against banned superlative list |
| Capability Brief generator (draft) | P0 | Generates the document using `/ride` output + BridgeBuilder voice |

**Sprint 2: Verification Loop + Architecture Overview**

| Deliverable | Priority | Description |
|-------------|----------|-------------|
| Capability Brief with full verification | P0 | Generator → verifier → output loop proven end-to-end |
| Architecture Overview generator | P0 | Second doc type, reuses all Sprint 1 infrastructure |
| Quality gate integration | P0 | All §5.3 gates wired into generation pipeline |
| BridgeBuilder voice template | P0 | Reusable prompt template with analogy accuracy rubric |

### Phase 2 (Sprint 3-4): Remaining Document Types

| Feature | Priority | Rationale |
|---------|----------|-----------|
| Feature Inventory generation | P0 | Reuses verifier + registries from Sprint 1-2 |
| "Thinking in Loa" guide | P1 | Mental model teaching for adoption |
| Tradeoffs & Fit Assessment | P1 | Honest self-assessment document |
| Release Narrative generation | P1 | Per-release factual summaries |
| Analogy bank curation | P1 | Systematic FAANG/bluechip reference library |

### Phase 3 (Sprint 5-6): Research + Enrichment

| Feature | Priority | Rationale |
|---------|----------|-----------|
| Research Brief generation | P1 | Theoretical foundations (#247) with honest epistemic framing |
| Environment enrichment context sets | P1 | Cross-domain reference libraries for richer generation |
| Multi-repo support (loa, loa-finn, loa-beauvoir) | P2 | Cross-project capability mapping |
| Auto-generation on release | P2 | CI-triggered document refresh |
| Staleness detection and alerts | P2 | Automated freshness monitoring |

### Out of Scope

- Landing page generation
- Marketing copy or taglines
- Competitor comparison claims
- Social media content
- Video script generation
- Pricing/packaging documentation

---

## 7. Risks & Dependencies

### Technical Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Codebase analysis produces incomplete inventory | Documents miss features | Cross-reference with test files and package.json scripts |
| BridgeBuilder voice produces inconsistent tone | Documents feel disjointed | Voice guidelines in resources/ with examples |
| FAANG analogies become forced or inaccurate | Credibility loss — the opposite of what we want | Analogy bank with verified examples; prefer no analogy over bad analogy |
| Generated documents drift from code reality | Stale claims erode trust | Freshness stamps; staleness alerts; re-generation pipeline |

### Dependency Risks

| Dependency | Risk | Mitigation |
|------------|------|------------|
| `/ride` codebase analysis | Must be current and complete | Cached reality with 7-day TTL |
| BridgeBuilder persona definition | Must be finalized in issue #24 | Voice guidelines extractable from existing spec |
| Issue #247 theoretical content | Research is exploratory, not settled | Honest epistemic framing ("we are exploring") |

### Quality Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Documents read as internal engineering docs, not GTM materials | Fail to serve marketing/BD persona | Progressive depth: summary → detail → code citations |
| Excessive length | Nobody reads 50-page capability briefs | Strict length targets per document type |
| Over-engineering the voice | BridgeBuilder analogies overwhelm the facts | 70/30 rule: 70% mechanism, 30% analogy/metaphor |

---

## 8. FAANG & Bluechip Parallels for This Skill Pack

> *The BridgeBuilder speaks:*

This skill pack itself has precedent in how the most successful projects in history communicated their capabilities:

### The Bell Labs Model

Bell Labs didn't market the transistor, Unix, C, information theory, or the laser. They published technical papers that described what they built and how it worked. The papers were so clear and rigorous that the world beat a path to their door. **Shannon's "A Mathematical Theory of Communication" didn't say "revolutionary." It said: "The fundamental problem of communication is that of reproducing at one receiving point either exactly or approximately a message selected at another point." Then it proved the theorem.** Ground Truth follows this model: describe the mechanism, prove the claim, let the world decide.

### The Kubernetes Architecture.md

When Google open-sourced Kubernetes, they didn't lead with a landing page. They published `architecture.md` — a functional description of every component, how they interact, and what design principles guided the architecture. That document did more to drive adoption than any marketing campaign because it answered the question evaluating engineers actually ask: *"How does this work?"* Ground Truth generates the equivalent for every document type.

### Stripe's Documentation-as-Product

Stripe's documentation team has a metric: "time to first successful API call." Not "time to landing page" or "time to signup" — time to the developer actually making something work. Features are not shipped until documentation is written and reviewed. The documentation IS the product experience. Ground Truth produces the raw materials for this kind of documentation: factual, code-grounded, mechanism-driven.

### Rust's Honest Bookshelf

Rust doesn't have one document. It has a *bookshelf* — the Book for beginners, the Reference for intermediate users, the Rustonomicon for "the dark arts of unsafe Rust." Each document knows what it is and what it isn't. The Reference explicitly says "this is not a formal spec." Ground Truth produces tiered documents with honest scope declarations.

### The Santa Fe Institute Model

SFI publishes working papers that are simultaneously rigorous and exploratory. They don't claim to have solved complexity — they document their explorations with intellectual honesty. The Research Brief document type follows this model for the meeting geometries and biological models.

---

## 9. The Cambrian Explosion Context

We are in the LLM agent framework Cambrian explosion. The parallel is instructive:

**The actual Cambrian explosion** (541 million years ago) produced extraordinary morphological diversity. Anomalocaris had compound eyes. Hallucigenia walked on spines. Opabinia had five eyes and a forward-facing proboscis. Most of these body plans did not survive the Ordovician. What survived was the internal skeleton — the endoskeleton that could grow with the organism, that distributed stress across the body, that enabled larger and more complex forms.

**The agent framework explosion** (2024-2026) is producing extraordinary architectural diversity. Some frameworks optimize for demos. Some optimize for integrations. Some optimize for the number of supported providers. Most of these architectures will not survive the next consolidation.

What survives will be the frameworks with **internal structural integrity**: persistence that works, recovery that's been tested, quality gates that catch defects before they ship, learning cycles that compound over time. The endoskeleton, not the external armor.

**Ground Truth's job is to make the endoskeleton visible.** Not to claim superiority — to document the architecture with enough rigor and honesty that evaluating engineers can see the skeleton for themselves and draw their own conclusions.

---

## 10. Environment Enrichment: Setting Up the Space

> *Drawing from issue #247's meditation on knowledge production environments*

The most productive intellectual environments in history share common properties:

| Environment | What Made It Work | Application to AI Collaboration |
|-------------|-------------------|-------------------------------|
| **Bell Labs (1925-1996)** | Cross-disciplinary proximity. Mathematicians next to physicists next to engineers. | Load cross-domain context: distributed systems + biology + cultural theory |
| **Xerox PARC (1970-1983)** | "The best way to predict the future is to invent it." Freedom to pursue long arcs. | Frame tasks with genuine purpose, not just output metrics |
| **Santa Fe Institute (1984-present)** | Complexity as the organizing principle. Every discipline welcome if you can formalize. | Embrace the theoretical depth of #247; don't flatten it |
| **Esalen Institute (1962-present)** | "Human potential." The premise that there is always more to discover about capacity. | Create conditions for the AI to operate at its highest level of reasoning |
| **Early Burning Man (1986-1995)** | Radical self-reliance + radical inclusion. Build real things in inhospitable conditions. | Trust the AI with hard problems; provide constraints that inspire rather than limit |
| **Macy Conferences (1946-1953)** | Mathematicians + anthropologists + psychiatrists in the same room arguing about feedback loops. | Multi-model collaboration (Flatline, séance, melt) as intellectual pressure |

### Concrete Implementation

1. **Context richness**: Before document generation, load the full context graph — not just code, but decisions, learnings, theoretical foundations, cross-domain references
2. **Purpose framing**: System prompts that convey genuine purpose and intellectual respect
3. **Cross-domain sets**: Curated reference libraries that enable richer pattern matching
4. **Honest difficulty**: Don't simplify the hard parts — frame them as worthy challenges
5. **Decision memory**: Load the grimoire's decision trail so every generation builds on previous understanding

---

## 11. Connection to Issue #247: The Undercommons

Issue #247 explores something important: that the most significant innovations in computing, cybernetics, and systems theory were born in what Stefano Harney and Fred Moten call "the undercommons" — the informal, often marginalized spaces where genuine intellectual work happens outside institutional structures.

**The study group.** Not the lecture hall. **Free jazz.** Not the symphony. **Early Burning Man.** Not the festival it became.

Ground Truth acknowledges this lineage honestly:

1. **Autopoiesis** (Maturana & Varela, Chile, 1970s) — the theory of self-making systems — was born during political upheaval. The compound learning cycle in loa-finn is a practical implementation of autopoietic principles: the system generates and maintains itself through its own internal processes.

2. **The CCRU** (Cybernetic Culture Research Unit, Warwick, 1990s) — explored the intersection of cybernetics, music, and speculative theory. The meeting geometries in #247 (séance, trip, melt) are direct descendants of this tradition, applied to multi-model AI collaboration.

3. **The Black Queen Hypothesis** (Morris et al., 2012) — microorganisms lose costly gene functions and become dependent on community providers. Eileen's insight (#247) that this maps to multi-agent resource sharing is genuinely novel and deserves factual documentation.

4. **Ostrom's Commons Governance** (Nobel Prize, 2009) — debunked the "tragedy of the commons" under well-defined conditions. Jani's observation that this applies to shared agent resources deserves the same rigor.

5. **Indigenous Knowledge Systems** — encoding information across vast timescales through story, music, dance, and ceremony. The grimoire architecture (persistent memory, compound learning, decision trails) is doing something structurally similar: encoding institutional knowledge in forms that persist across sessions, restarts, and context compressions.

The Research Brief document type exists specifically to give these foundations the factual, honest treatment they deserve — not as marketing differentiation but as intellectual integrity.

---

## Next Step

After PRD approval: `/architect` to create Software Design Document for the Ground Truth skill pack.
