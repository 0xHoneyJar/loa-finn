# Sprint Plan: Ground Truth — Factual GTM Skill Pack

> **Version**: 1.0.0
> **Date**: 2026-02-10
> **PRD**: `grimoires/loa/prd-ground-truth.md` v1.1.0 (GPT-5.2 APPROVED)
> **SDD**: `grimoires/loa/sdd-ground-truth.md` v1.1.0 (GPT-5.2 APPROVED)
> **Cycle**: cycle-010
> **Global Sprint IDs**: 25-26

---

## Overview

| Property | Value |
|----------|-------|
| Total Sprints | 2 (MVP) |
| Total Tasks | 26 |
| Scope | Capability Brief + Architecture Overview with full deterministic verification pipeline |
| Phase 2-3 | Outlined but not scheduled — remaining 5 doc types after MVP is proven |

**Strategy**: Capability Brief + verification infrastructure first (Sprint 1), then prove the repair loop + add Architecture Overview (Sprint 2). No doc type ships without passing all quality gates.

**Key Constraint**: No new TypeScript. Entire implementation is SKILL.md + shell scripts + resource files.

---

## Sprint 1: Verification Infrastructure + Capability Brief Draft

**Goal**: Build the complete deterministic verification pipeline and produce a first Capability Brief that passes all quality gates.

**Why this ordering**: The verification scripts are the core safety guarantee. Without them, generated documents are unverifiable LLM output. Building verification first means every document generated — even drafts — goes through the firewall.

### Tasks

#### 1.1 Create registry directory and bootstrap script

**Description**: Create `grimoires/loa/ground-truth/` directory and implement `bootstrap-registries.sh` that generates starter YAML files with TODO placeholders.

**Acceptance Criteria**:
- [ ] `grimoires/loa/ground-truth/` directory exists
- [ ] `.claude/scripts/ground-truth/bootstrap-registries.sh` creates `features.yaml`, `limitations.yaml`, `capability-taxonomy.yaml` with correct schemas
- [ ] Script exits 1 if files already exist (no overwrite)
- [ ] Script exits 2 if target directory missing

**Effort**: Low
**Dependencies**: None
**Component**: Script

---

#### 1.2 Curate `features.yaml` with initial feature inventory

**Description**: Run `/ride` or review existing reality files to identify all top-level features. Create `features.yaml` with canonical `id` (kebab-case), `name`, `status`, `category`, and `modules[]` array for each feature.

**Acceptance Criteria**:
- [ ] Every `src/` top-level module mapped to a feature entry
- [ ] Each entry has unique `id`, valid `status` (stable/experimental/deprecated/planned), `category` matching taxonomy, and at least one module path
- [ ] File parseable by `yq '.features[] | .id'`
- [ ] At least 7 features mapped (persistence, orchestration, bridgebuilder, scheduling, identity, gateway, hounfour)

**Effort**: Medium (requires codebase knowledge)
**Dependencies**: 1.1
**Component**: Registry

---

#### 1.3 Create `limitations.yaml` from TODO/FIXME extraction

**Description**: Grep `src/` for TODO and FIXME tags, cross-reference with known design limitations, and create `limitations.yaml` with `feature_id` join keys referencing `features.yaml`.

**Acceptance Criteria**:
- [ ] Every `feature_id` matches an `id` in `features.yaml`
- [ ] At least 5 limitations documented
- [ ] Each entry has `description`, `reason`, and optional `decision_ref`
- [ ] File parseable by `yq '.limitations[] | .feature_id'`

**Effort**: Low
**Dependencies**: 1.2
**Component**: Registry

---

#### 1.4 Create `capability-taxonomy.yaml`

**Description**: Define the top-level capability categories that structure the Capability Brief. Every feature in `features.yaml` must map to one of these categories.

**Acceptance Criteria**:
- [ ] 7 top-level capabilities defined (persistence, orchestration, review, learning, scheduling, identity, deployment)
- [ ] Each entry has `id`, `name`, `description`
- [ ] Every `category` value in `features.yaml` matches a taxonomy `id`

**Effort**: Low
**Dependencies**: 1.2
**Component**: Registry

---

#### 1.5 Create `banned-terms.txt`

**Description**: Create the banned superlative/adjective list from PRD §2. One term per line, case-insensitive matching.

**Acceptance Criteria**:
- [ ] Contains at least 15 banned terms: blazing, revolutionary, enterprise-grade, cutting-edge, world-class, game-changing, next-generation, best-in-class, state-of-the-art, unparalleled, seamless, turnkey, robust (as standalone adjective), scalable (without mechanism), powerful (without mechanism)
- [ ] One term per line, no regex — plain strings for case-insensitive grep

**Effort**: Trivial
**Dependencies**: None
**Component**: Registry

---

#### 1.6 Implement `verify-citations.sh`

**Description**: The core verification script. Implements 5-step citation checking: EXTRACT → PATH_SAFETY → FILE_EXISTS → LINE_RANGE → EVIDENCE_ANCHOR. This is the highest-complexity script and the most critical safety boundary.

**Acceptance Criteria**:
- [ ] Extracts backtick-wrapped `path/file.ext:NN(-MM)` citation patterns. **Citation encoding rule**: repo-relative paths only, no spaces allowed in citation paths (paths with spaces must use a short symlink or be excluded from citations). Paths must match `^[a-zA-Z0-9_./-]+$`
- [ ] PATH_SAFETY runs before any file read: rejects `..`, leading `/`, control chars, spaces; requires `git ls-files -z` exact match. Returns normalized repo-relative path for downstream use
- [ ] FILE_EXISTS checks normalized path against git index
- [ ] LINE_RANGE extracts cited lines via `sed` on normalized path only
- [ ] EVIDENCE_ANCHOR parses `<!-- evidence: symbol=X, literal="Y" -->` and checks each token against extracted lines
- [ ] Exit codes: 0 (pass), 1 (fail), 2 (unreadable), 3 (path safety violation)
- [ ] JSON output with `total_citations`, `verified`, `failed`, `failures[]`
- [ ] Fixture tests: at least 1 valid citation (pass), 1 bad path (exit 3), 1 missing file (exit 1), 1 wrong line range (exit 1), 1 missing anchor token (exit 1)

**Effort**: High
**Dependencies**: None
**Component**: Script

---

#### 1.7 Implement `scan-banned-terms.sh`

**Description**: Scans generated markdown for banned superlatives. Uses awk state machine to strip non-prose content (frontmatter, code fences, HTML comments, blockquotes) before scanning.

**Acceptance Criteria**:
- [ ] Awk preprocessor correctly skips: YAML frontmatter (`---`), fenced code blocks (`` ``` ``), HTML comments (`<!-- -->`), blockquotes (`> `)
- [ ] Combined regex scan (terms joined with `|`) on cleaned prose
- [ ] Exit codes: 0 (clean), 1 (terms found), 2 (unreadable)
- [ ] JSON output listing found terms with line numbers
- [ ] False positive test: "enterprise-grade" inside a code block is NOT flagged

**Effort**: Low-Medium
**Dependencies**: 1.5
**Component**: Script

---

#### 1.8 Implement `check-provenance.sh`

**Description**: Validates that every taggable paragraph has a provenance classification tag and that tag-specific citation rules are met.

**Acceptance Criteria**:
- [ ] Awk state machine with 6 states: NORMAL, IN_FRONTMATTER, IN_FENCE, IN_TABLE, IN_HTML_COMMENT, IN_BLOCKQUOTE
- [ ] Only NORMAL-state paragraphs are taggable (non-whitespace, non-markdown-control lines)
- [ ] **Provenance tag syntax**: `<!-- provenance: CLASS -->` HTML comment on the line immediately before or after a paragraph, where CLASS is one of: CODE-FACTUAL, REPO-DOC-GROUNDED, ISSUE-GROUNDED, ANALOGY, HYPOTHESIS, EXTERNAL-REFERENCE
- [ ] **Citation rules per class**: CODE-FACTUAL → must contain backtick `file:line` citation; HYPOTHESIS → paragraph must start with epistemic marker ("we hypothesize", "we are exploring", "we believe"); EXTERNAL-REFERENCE → must contain URL (`https://`) or paper/book reference in parentheses
- [ ] 4 checks: TAG_COVERAGE (≥95%), CODE_FACTUAL_CITATION (100% must cite file:line), HYPOTHESIS_MARKER (must have epistemic prefix), EXTERNAL_REFERENCE_CITATION (must cite URL/paper)
- [ ] Exit codes: 0 (pass), 1 (fail), 2 (unreadable)
- [ ] JSON output with coverage percentage and failures list

**Effort**: Medium-High
**Dependencies**: None
**Component**: Script

---

#### 1.9 Implement `quality-gates.sh` orchestrator

**Description**: Orchestrates all verification scripts into a single pass/fail decision. Runs 5 blocking gates sequentially, then 2 warning gates.

**Acceptance Criteria**:
- [ ] Runs 5 blocking gates in order: (1) verify-citations.sh, (2) scan-banned-terms.sh, (3) check-provenance.sh, (4) freshness-check (inline: verify `<!-- ground-truth-meta: ... -->` block has `head_sha` matching current HEAD and `generated_at` within 7 days), (5) registry-consistency (inline: verify every `features.yaml` category matches a `capability-taxonomy.yaml` id, and every `limitations.yaml` feature_id matches a `features.yaml` id, using `yq`)
- [ ] Freshness-check and registry-consistency are implemented **inline** in quality-gates.sh (not separate scripts) since they are simple `yq`/`git` one-liners
- [ ] 2 warning gates (non-blocking): analogy-accuracy (≥1 analogy per major section), mechanism-density (≥1 "does X by Y" pattern per capability section)
- [ ] Halts on first blocking failure (fail-fast)
- [ ] Aggregates all results into single JSON report
- [ ] Exit codes: 0 (all blocking gates pass), 1 (any blocking gate fails)
- [ ] Accepts `--json` flag for structured output
- [ ] Checks registry file existence at startup (fail-fast per SDD §8.3)

**Effort**: Low-Medium
**Dependencies**: 1.6, 1.7, 1.8, 1.12
**Component**: Script

---

#### 1.10 Implement `inventory-modules.sh`

**Description**: Enumerates `src/` modules, parses imports, and cross-references with `features.yaml` and `limitations.yaml` registries.

**Acceptance Criteria**:
- [ ] Traverses `src/` top-level directories
- [ ] Extracts primary exports and import dependencies
- [ ] Cross-references each module path against `features.yaml` `modules[]` arrays
- [ ] Emits `module_path`, `feature_ids[]`, `status`, `category` per module
- [ ] Missing registry match → `status=unknown`, WARNING (non-blocking)
- [ ] Multiple matches → deterministic: all matching feature_ids listed
- [ ] JSON output parseable by `jq`

**Effort**: Medium
**Dependencies**: 1.2
**Component**: Script

---

#### 1.11 Implement `extract-limitations.sh`

**Description**: Greps `src/` for TODO/FIXME tags and merges with `limitations.yaml` entries.

**Acceptance Criteria**:
- [ ] Extracts `TODO:`, `FIXME:`, `HACK:`, `XXX:` tags with file:line context
- [ ] Merges with `limitations.yaml` entries by feature_id
- [ ] JSON output with source (code-tag vs registry) for each limitation

**Effort**: Low
**Dependencies**: 1.3
**Component**: Script

---

#### 1.12 Implement `stamp-freshness.sh`

**Description**: Appends metadata block to generated documents with HEAD SHA, timestamp, and registry checksums.

**Acceptance Criteria**:
- [ ] Appends `<!-- ground-truth-meta: ... -->` block at document end
- [ ] Includes: `head_sha`, `generated_at`, `features_sha`, `limitations_sha`, `ride_sha`
- [ ] Idempotent: replaces existing meta block if present

**Effort**: Trivial
**Dependencies**: None
**Component**: Script

---

#### 1.13 Create Capability Brief template

**Description**: Structural scaffold for the Capability Brief document type. Defines required sections, provenance expectations per section, and evidence anchor patterns.

**Acceptance Criteria**:
- [ ] Template includes: Overview, Capability sections (one per taxonomy category), Design Principles, Limitations & Honest Assessment
- [ ] Each section annotated with expected provenance class and minimum citation count
- [ ] Template is Tier A constraint (loaded first in context)
- [ ] Evidence anchor pattern documented in template comments

**Effort**: Low
**Dependencies**: 1.4
**Component**: Resource

---

#### 1.14 Create BridgeBuilder voice template

**Description**: Extract BridgeBuilder persona rules from loa-finn#24 into a reusable prompt template for GTM generation.

**Acceptance Criteria**:
- [ ] Voice rules: mechanism over adjective, FAANG parallels when structurally genuine, 70/30 mechanism/analogy ratio
- [ ] Bounded analogy rule: ≥1 per major section, optional per sub-section, prefer no analogy over forced one
- [ ] Template loadable as additional context (Tier B)

**Effort**: Low
**Dependencies**: None
**Component**: Resource

---

#### 1.15 Write SKILL.md with 7-stage pipeline

**Description**: Create the main skill definition file implementing the generate-then-verify pipeline with repair loop.

**Acceptance Criteria**:
- [ ] Frontmatter: `context: fork`, `agent: general-purpose`, `danger_level: moderate`
- [ ] `allowed-tools`: Bash restricted to `.claude/scripts/ground-truth/*.sh`; Read tool always permitted
- [ ] 7-stage workflow: GROUND → INVENTORY → GENERATE → VERIFY → REPAIR (max 3) → OUTPUT → MANIFEST
- [ ] Two-tier context loading: Tier A (templates, quality gates, provenance rules) → Tier B (code reality > registries > grimoire > voice > analogies)
- [ ] Token budget management with documented estimates per context type
- [ ] Repair loop: passes failure JSON to LLM with repair rules; uses Read tool for file inspection
- [ ] **Repair interface contract**: repair prompt receives (1) failure JSON from quality-gates.sh, (2) the generated markdown draft; repair may ONLY edit the generated markdown file (not source code, not registries); output is a full rewrite of the markdown file; SKILL.md guards against edits outside `grimoires/loa/ground-truth/`
- [ ] `--type` flag supporting: `capability-brief`, `architecture-overview`
- [ ] Fail-fast on missing registries with bootstrap command message
- [ ] **Execution entrypoint**: SKILL.md is the Loa runtime entrypoint — Loa reads SKILL.md and executes the described workflow stages. Acceptance test: `/ground-truth --type capability-brief` invokes the skill and reaches the GENERATE stage

**Effort**: High
**Dependencies**: 1.6, 1.7, 1.8, 1.9, 1.13, 1.14
**Component**: Skill

---

#### 1.16 Create provenance tag spec resource file

**Description**: Define the exact provenance tag syntax, citation patterns, and epistemic marker strings in a resource file that both the generator and verifier reference as their shared contract.

**Acceptance Criteria**:
- [ ] Resource file at `.claude/skills/ground-truth/resources/provenance-spec.md`
- [ ] Defines tag syntax: `<!-- provenance: CLASS -->` where CLASS is one of 6 provenance classes
- [ ] Defines citation patterns: backtick `file:line` for CODE-FACTUAL; `grimoires/loa/...` section ref for REPO-DOC-GROUNDED; `#NNN` for ISSUE-GROUNDED; URL for EXTERNAL-REFERENCE
- [ ] Defines epistemic marker strings: "we hypothesize", "we are exploring", "we believe", "early evidence suggests"
- [ ] Defines evidence anchor syntax: `<!-- evidence: symbol=X, literal="Y" -->`
- [ ] Referenced by SKILL.md (Tier A constraint) and check-provenance.sh

**Effort**: Low
**Dependencies**: None
**Component**: Resource

---

#### 1.17 Create golden test fixtures and test harness

**Description**: Create deterministic test fixtures for all verification scripts and a `run-tests.sh` harness that asserts exit codes and key JSON fields.

**Acceptance Criteria**:
- [ ] Test directory at `tests/ground-truth/fixtures/` with known-pass and known-fail markdown files
- [ ] Fixtures cover: frontmatter, fenced code blocks, HTML comments, blockquotes, tables, evidence anchors, provenance tags, banned terms
- [ ] `tests/ground-truth/run-tests.sh` executes each verifier against fixtures and asserts exit codes + JSON field values via `jq`
- [ ] At least 1 fixture per failure mode: bad path (exit 3), missing file (exit 1), wrong line range (exit 1), missing anchor (exit 1), banned term in prose (exit 1), missing provenance tag (exit 1)
- [ ] At least 1 passing fixture that exercises all 5 blocking gates
- [ ] Harness returns exit 0 if all assertions pass, exit 1 if any fail

**Effort**: Medium
**Dependencies**: 1.6, 1.7, 1.8, 1.9
**Component**: Test

---

### Sprint 1 Summary

| Metric | Value |
|--------|-------|
| Tasks | 17 |
| High effort | 2 (verify-citations.sh, SKILL.md) |
| Medium effort | 5 (features.yaml, check-provenance.sh, inventory-modules.sh, quality-gates.sh, test fixtures) |
| Low effort | 8 |
| Trivial effort | 2 |
| Blocking dependencies | 1.9 depends on 1.6+1.7+1.8+1.12; 1.15 depends on 1.9+1.13+1.14; 1.17 depends on 1.6+1.7+1.8+1.9 |

**Sprint 1 Definition of Done**: `quality-gates.sh` can be invoked on test fixtures and produces correct pass/fail results for all 5 blocking gates. Test harness (`run-tests.sh`) passes all assertions. SKILL.md is syntactically valid and `/ground-truth --type capability-brief` reaches the GENERATE stage.

---

## Sprint 2: Repair Loop Proof + Architecture Overview

**Goal**: Prove the verify → repair → re-verify loop converges, add the Architecture Overview doc type, and run end-to-end generation for both document types.

**Why this ordering**: Sprint 1 built the pipeline components. Sprint 2 proves they work together — specifically that the repair loop can actually fix verification failures within 3 iterations. This is the critical integration risk.

### Tasks

#### 2.1 Prove verify → repair → re-verify loop

**Description**: Integration test of the repair loop. Deliberately introduce citation errors in a test document and verify the LLM repair path fixes them within 3 iterations.

**Acceptance Criteria**:
- [ ] **Repair prompt template** exists in SKILL.md: receives failure JSON + draft markdown; instructs LLM to fix citations/claims; explicitly states "only edit the generated markdown at `grimoires/loa/ground-truth/{doc}.md`"
- [ ] **Edit guard**: SKILL.md workflow rejects any repair that writes outside `grimoires/loa/ground-truth/`
- [ ] **Patch method**: full rewrite of generated markdown file (not diff-based); verifier runs on the new version
- [ ] Test case 1: Wrong line number in citation → repair finds correct line → passes on iteration 2
- [ ] Test case 2: Missing evidence anchor → repair adds anchor → passes on iteration 2
- [ ] Test case 3: Banned term in prose → repair replaces with mechanism description → passes on iteration 2
- [ ] Test case 4: Missing provenance tag → repair adds tag → passes on iteration 2
- [ ] Test case 5: Ungroundable claim → repair converts CODE-FACTUAL to HYPOTHESIS → passes
- [ ] All 5 test cases converge within 3 iterations
- [ ] Uses Sprint 1 test fixtures as baseline inputs where applicable

**Effort**: High
**Dependencies**: Sprint 1 complete (especially 1.15, 1.17)
**Component**: Integration

---

#### 2.2 Create Architecture Overview template

**Description**: Structural scaffold for the Architecture Overview document type.

**Acceptance Criteria**:
- [ ] Template includes: System Overview, 5-Layer Architecture, Component Interactions, Design Principles, FAANG Parallels
- [ ] Each section annotated with expected provenance class
- [ ] Template references `src/` architecture layers: persistence, orchestration, identity, bridgebuilder, scheduling

**Effort**: Low
**Dependencies**: None
**Component**: Resource

---

#### 2.3 Generate first Capability Brief end-to-end

**Description**: Run `/ground-truth --type capability-brief` through the full pipeline. This is the first real document generated with all quality gates active.

**Acceptance Criteria**:
- [ ] Document generated at `grimoires/loa/ground-truth/capability-brief.md`
- [ ] All 5 blocking quality gates pass
- [ ] Every CODE-FACTUAL paragraph has evidence anchors verified against actual code
- [ ] At least 1 BridgeBuilder analogy per major section
- [ ] 0 banned terms in output
- [ ] ≥95% provenance tag coverage
- [ ] Freshness stamp present with current HEAD SHA

**Effort**: Medium
**Dependencies**: 2.1 (repair loop proven)
**Component**: Test

---

#### 2.4 Generate Architecture Overview end-to-end

**Description**: Run `/ground-truth --type architecture-overview` through the full pipeline. Proves the pipeline generalizes to a second doc type.

**Acceptance Criteria**:
- [ ] Document generated at `grimoires/loa/ground-truth/architecture-overview.md`
- [ ] All 5 blocking quality gates pass
- [ ] 5-layer architecture documented with citations
- [ ] Design principles have FAANG parallels

**Effort**: Medium
**Dependencies**: 2.2, 2.3
**Component**: Test

---

#### 2.5 Create `generation-manifest.json` writer

**Description**: After successful generation, write a manifest file tracking what was generated, when, and with what inputs.

**Acceptance Criteria**:
- [ ] JSON manifest at `grimoires/loa/ground-truth/generation-manifest.json`
- [ ] Per-document entry: `path`, `generated` timestamp, `checksum`, `citations_verified` count, `quality_gates` status, `warnings` count
- [ ] Includes `head_sha`, `ride_sha`, registry SHAs
- [ ] Manifest updated (not overwritten) on each generation run

**Effort**: Low
**Dependencies**: None
**Component**: Script

---

#### 2.6 Wire beads integration (optional)

**Description**: If beads_rust is available, track document generation as beads tasks.

**Acceptance Criteria**:
- [ ] `br create --label "ground-truth:{doc-type}"` before generation
- [ ] `br close` on success with citation count in notes
- [ ] `br update --status blocked` on repair loop exhaustion
- [ ] Graceful skip if `br` not available

**Effort**: Low
**Dependencies**: None
**Component**: Integration

---

#### 2.7 Create analogy bank starter

**Description**: Create `analogies/analogy-bank.yaml` with initial FAANG/bluechip parallels extracted from PRD and existing BridgeBuilder content.

**Acceptance Criteria**:
- [ ] At least 10 validated analogies covering: persistence (PostgreSQL WAL), orchestration (K8s), review (Stripe docs), learning (TensorFlow), scheduling (Airflow), deployment (Vercel), security (HashiCorp Vault)
- [ ] Each entry: `domain`, `parallel`, `structural_similarity`, `source`
- [ ] Analogies are factually accurate about the referenced project

**Effort**: Low
**Dependencies**: None
**Component**: Resource

---

### Sprint 2 Summary

| Metric | Value |
|--------|-------|
| Tasks | 7 |
| High effort | 1 (repair loop proof) |
| Medium effort | 2 (Capability Brief + Architecture Overview generation) |
| Low effort | 4 |
| Blocking dependencies | 2.3 depends on 2.1; 2.4 depends on 2.2+2.3 |

**Sprint 2 Definition of Done**: Both Capability Brief and Architecture Overview generated, verified, and passing all quality gates. Repair loop proven to converge within 3 iterations. Generation manifest present with correct metadata.

---

## Phase 2 Outline (Sprint 3-4, Not Yet Scheduled)

After MVP is proven stable:

| Sprint | Goal | Doc Types |
|--------|------|-----------|
| Sprint 3 | Remaining high-value doc types | Feature Inventory, "Thinking in Loa" |
| Sprint 4 | Self-assessment + release docs | Tradeoffs & Fit Assessment, Release Narrative |

**Prerequisite**: Sprint 1-2 complete with both doc types passing all gates consistently.

## Phase 3 Outline (Sprint 5-6, Not Yet Scheduled)

| Sprint | Goal | Doc Types |
|--------|------|-----------|
| Sprint 5 | Research + enrichment | Research Brief, environment enrichment context sets |
| Sprint 6 | Automation + multi-repo | Auto-generation on release, multi-repo support, staleness detection |

**Prerequisite**: Phase 2 complete. Flatline integration (SDD §6.3) may be implemented here.

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Repair loop non-convergence | Medium | High — blocks all output | Sprint 2 task 2.1 specifically tests this; circuit breaker halts after 3 iterations |
| `/ride` output insufficient for citations | Low | Medium — incomplete grounding | `/ride` is proven on this codebase; can re-run with deeper analysis |
| Registry curation takes longer than expected | Medium | Low — blocks Sprint 1 but not scripts | Bootstrap script provides starter; can iterate on registry content |
| Evidence anchor pattern too rigid | Low | Medium — generator struggles to emit | Anchors are simple `symbol=X` patterns; generator instructions are explicit |
| Awk state machine edge cases | Medium | Low — false positives in scanning | Golden test fixtures in check-provenance.sh catch common patterns |

---

## Dependencies

```
Sprint 1 Task Graph:
  1.1 ──→ 1.2 ──→ 1.3
              └──→ 1.4
              └──→ 1.10
  1.5 ──→ 1.7
  1.6 ─┐
  1.7 ─┤→ 1.9 ─┐
  1.8 ─┤        ├→ 1.15
  1.12─┘        ├→ 1.17 (test fixtures)
  1.13 ─────────┘
  1.14 ─────────┘
  1.16 (provenance spec — independent, needed by 1.8 and 1.15)
  (1.11, 1.12 — independent)

Sprint 2 Task Graph:
  Sprint 1 (esp. 1.15, 1.17) ──→ 2.1 ──→ 2.3 ──→ 2.4
  2.2 ──────────────────────────────────────┘
  (2.5, 2.6, 2.7 — independent)
```

---

## Next Step

After sprint plan approval: `/run sprint-1` to begin implementation.
