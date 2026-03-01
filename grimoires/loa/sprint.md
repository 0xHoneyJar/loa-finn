# Sprint Plan: Ground Truth Excellence — Bridgebuilder PR #122 Findings

**Cycle:** 039
**PRD:** `grimoires/loa/prd.md`
**SDD:** `grimoires/loa/sdd.md`
**Date:** 2026-02-28
**Team:** 1 AI developer + 1 human reviewer
**Sprint duration:** ~2-4 hours each (AI-paced)
**Source:** [Bridgebuilder Review on PR #122](https://github.com/0xHoneyJar/loa-finn/pull/122#issuecomment-3976999740) — 11 findings (2 MEDIUM, 1 LOW, 3 SPECULATION, 1 REFRAME, 4 PRAISE)
**Status:** PENDING

---

## Overview

This sprint plan addresses ALL findings from the Bridgebuilder review of PR #122, which documented the Ground Truth spoke files for loa-finn v8.3.1. The review reframed GT from "documentation" to "system immune system" — an active layer that detects drift, validates invariants, and provides machine-readable self-knowledge.

### Findings → Sprint Mapping

| Finding | Severity | Sprint | Tasks |
|---------|----------|--------|-------|
| medium-1: Error response schemas | MEDIUM | Sprint 1 | T-1.1 |
| medium-2: Invariant failure modes | MEDIUM | Sprint 1 | T-1.2, T-1.3 |
| low-1: Staging vs invariant claims | LOW | Sprint 1 | T-1.4 |
| speculation-1: Machine-consumable GT | SPECULATION | Sprint 2 | T-2.1–T-2.4 |
| speculation-2: GT as executable specs | SPECULATION | Sprint 3 | T-3.0–T-3.4 |
| speculation-3: Cross-repo GT federation | SPECULATION | Sprint 4 | T-4.4 |
| reframe-1: GT as immune system | REFRAME | Sprint 4 | T-4.0–T-4.3 |
| praise-1–4: Provenance, conservation, WAL, boot | PRAISE | — | Inform approach, no changes |

### Design Principles

1. **Incremental enrichment** — Each sprint layers new capability onto existing GT files without rewriting them
2. **Machine-readable first** — YAML schemas alongside markdown for agent consumption (hounfour issue #31 compatibility)
3. **Test-from-truth** — Property tests derived from GT invariants, not written independently
4. **Immune system framing** — Active detection, not passive description

---

## Sprint 1: Foundation — Error Schemas + Failure Modes + Provenance Tags

**Goal:** Address all MEDIUM and LOW findings with concrete documentation improvements to the existing GT spoke files.

**Findings addressed:** medium-1, medium-2, low-1
**Risk:** Low — documentation changes only, no application code
**Dependency:** None — builds on PR #122 GT files

### Tasks

#### T-1.1: Add error response schemas to api-surface.md
- Add "Common Error Response" section documenting the canonical error JSON shape
- Document specific response schemas for critical error codes on `/api/v1/invoke`:
  - 402: budget exceeded (does it return a quote? structured denial code from hounfour's `DenialCodeSchema`?)
  - 422: model unavailable (which models attempted?)
  - 429: rate limited (Retry-After header? window remaining?)
  - 503: circuit breaker (circuit state? cooldown remaining?)
- Read actual error handlers in `src/gateway/routes/invoke.ts` and `src/hounfour/router.ts` to extract real response shapes
- Include `file:line` provenance for each error schema
- **AC:** Each error code on `/api/v1/invoke` has a documented JSON response body with provenance
- **AC:** `ground-truth-gen.sh --mode validate` still passes (token budget)

#### T-1.2: Add failure mode documentation for billing invariants (INV-1 through INV-5)
- For each billing invariant in `contracts.md`, add a failure mode table:
  | Field | Description |
  |-------|-------------|
  | **Violation** | How the invariant can be broken |
  | **Detection** | How/where violation is caught |
  | **Recovery** | What happens when caught |
  | **Blast radius** | Scope of impact |
- Read `src/hounfour/billing-invariants.ts` for `assert*()` functions that detect violations
- Read `src/hounfour/billing-finalize-client.ts` for DLQ recovery behavior
- Read `src/billing/circuit-breaker.ts` for circuit breaker as blast radius limiter
- **AC:** All 5 billing invariants have failure mode documentation
- **AC:** Failure mode claims grounded with `file:line` citations

#### T-1.3: Add failure mode documentation for remaining invariant groups
- Extend failure mode documentation to WAL invariants (5), Auth contracts (5), and Credit conservation (2)
- Prioritize invariants on the critical path: WAL monotonicity, JTI replay protection, credit sum
- For Auth contracts, document what happens when ES256 enforcement blocks an HS256 attempt in production
- For Credit conservation, document what happens when the SQL CHECK fails (transaction rollback? error logged?)
- **AC:** At minimum 12 of 35 invariants have failure mode documentation (all billing + WAL + credit)
- **AC:** Token budget maintained (consider separate `failure-modes.md` spoke if contracts.md exceeds 2000-token limit)

#### T-1.4: Add deployment provenance tags to architecture.md
- Add `<!-- deployment: staging -->` annotations to staging-specific claims:
  - Task definition: 256 CPU, 512MB RAM
  - Cluster: `arrakis-staging-cluster`
  - Service: `loa-finn-armitage` revision 7
  - ECR image tag: `b4a3075`
- Add `<!-- deployment: invariant -->` annotations to architecture-invariant claims:
  - 5-layer architecture model
  - Module dependency graph
  - WAL authoritativeness
  - Invoke/Oracle data flow paths
- **AC:** Every claim in the Deployment Topology section has a deployment provenance tag
- **AC:** README or index notes the distinction for future contributors

#### T-1.5: Update GT index and checksums
- Regenerate checksums for all modified GT files
- Update claim counts in index.md if new sections added
- Run `ground-truth-gen.sh --mode validate` as final gate
- **AC:** Checksums match, validation passes, index accurate

---

## Sprint 2: Machine-Consumable GT — Contracts YAML

**Goal:** Create a machine-readable layer for GT invariants, enabling agent consumption and programmatic validation. This implements SPECULATION-1 from the Bridgebuilder review.

**Findings addressed:** speculation-1 (machine-consumable GT)
**Risk:** Medium — new file format requires schema design; must not conflict with existing GT validation
**Dependency:** Sprint 1 (failure modes inform YAML structure)
**Connection:** Enables hounfour issue #31 (permission scape) and issue #80 (Conway agent self-knowledge)

### Tasks

#### T-2.1: Inventory hounfour constraint schema + design contracts.yaml schema
- **Prerequisite step:** Read 3–5 representative hounfour constraint files (e.g., `BillingInvariant.constraints.json`, `ModelRouting.constraints.json`, `AuthPolicy.constraints.json`) and document the exact fields/patterns (`$schema`, `type_signature`, `message`, etc.)
- Create a mapping table: hounfour constraint fields → contracts.yaml fields
- Define YAML schema for machine-readable invariants with fields:
  ```yaml
  invariants:
    - id: INV-1
      name: COMPLETENESS
      domain: billing
      statement: "Every finalize() returns one of: finalized, idempotent, dlq"
      source:
        file: src/hounfour/billing-invariants.ts
        line: 12
      enforcement:
        file: src/hounfour/billing-invariants.ts
        lines: [28, 38]
        function: assertCompleteness
      preconditions:
        - "billing entry exists with state FINALIZE_PENDING"
      postconditions:
        - "outcome ∈ {finalized, idempotent, dlq}"
      failure:
        detection: "assertCompleteness() throws"
        recovery: "DLQ entry created with UNKNOWN outcome"
        blast_radius: "Single billing entry. No cascade."
      version: "8.3.1"
  ```
- Align with hounfour's constraint file schema; document any fields that cannot be mapped cleanly
- **AC:** Mapping table from hounfour constraint fields → contracts.yaml fields documented and reviewer-approved
- **AC:** Schema documented in a comment header within the YAML file
- **AC:** Schema covers all fields needed for property test generation (Sprint 3)

#### T-2.2: Generate contracts.yaml from contracts.md
- Create `grimoires/loa/ground-truth/contracts.yaml` with all 35 invariants from contracts.md
- Include failure mode data from Sprint 1 where available
- Maintain bidirectional traceability: YAML `id` field matches markdown heading anchor
- **AC:** `contracts.yaml` parses without error (validated via script or `yq`)
- **AC:** Every invariant in contracts.md has a corresponding entry in contracts.yaml

#### T-2.3: Create YAML validation script + CI wiring
- Add `scripts/validate-gt-yaml.sh` (or extend `ground-truth-gen.sh`)
- Validate: required fields present, source files exist, line ranges valid
- Validate: no duplicate invariant IDs
- Validate: YAML parses cleanly
- Wire into `.github/workflows/ci.yml` as a new job `gt-yaml-validate` that runs on `pull_request` to `main`
- **AC:** Script catches missing required fields and reports clear errors
- **AC:** PR check named `GT YAML Validate` appears in GitHub status checks and fails on malformed YAML

#### T-2.4: Update GT index for YAML format
- Add `contracts.yaml` to the GT index spokes table
- Document the YAML schema in a section of index.md or as a linked schema file
- Update checksums.json with new file
- **AC:** Index accurately reflects both `.md` and `.yaml` GT files

---

## Sprint 3: Executable Specifications — Property Tests from Invariants

**Goal:** Close the loop between GT claims and test verification by generating property-based tests from GT invariants. This implements SPECULATION-2 from the Bridgebuilder review.

**Findings addressed:** speculation-2 (GT as executable specification)
**Risk:** Medium — property tests need careful fast-check setup; must not duplicate existing tests
**Dependency:** Sprint 2 (YAML schema enables programmatic test generation)
**Connection:** Extends existing test-first culture (4681 tests) by deriving tests FROM documented invariants

### Tasks

#### T-3.0: Audit existing test coverage + discover test seams
- Locate existing tests covering INV-1/3/5 (billing) and credit conservation/nonce replay
- For each invariant targeted in T-3.2 and T-3.3, document:
  - Existing test file:line (or explicit absence)
  - Callable function entrypoint for the invariant assertion
  - Dependencies required (DB, WAL, time, queues) and strategy (fake clock, in-memory DB, or test doubles)
- Determine unit vs integration scope per invariant
- **AC:** For each new GT-derived test, link to (or explicitly state absence of) existing test coverage by file path
- **AC:** Each selected invariant has a documented test seam (function entrypoint + dependencies) and a deterministic clock/DB strategy

#### T-3.1: Create GT-derived property test harness
- Create `tests/finn/ground-truth/` directory for GT-derived tests
- Set up fast-check integration for property-based testing
- Create helper `loadGTInvariants()` that reads `contracts.yaml` and returns typed invariant objects
- Design test naming convention: `[INV-ID] [invariant name]` for clear traceability to GT
- **AC:** Test harness can load contracts.yaml and iterate over invariants
- **AC:** Helper functions are typed and documented

#### T-3.2: Generate property tests for billing invariants
- INV-1 (Completeness): Property test that `finalize()` always returns one of the 3 valid outcomes
- INV-3 (Idempotency): Property test that duplicate `finalize()` with same `reservation_id` returns `idempotent`
- INV-5 (Bounded Retry): Property test that DLQ entries are replayed at most `maxRetries` times
- Use fast-check arbitraries to generate valid billing entries, reservation IDs, and retry counts
- **AC:** 3 property tests pass, each traceable to a specific GT invariant by ID
- **AC:** Tests fail if the invariant is violated (negative verification)

#### T-3.3: Generate property tests for credit conservation
- Sum Invariant: Property test that `allocated + unlocked + reserved + consumed + expired = initial_allocation` holds after any sequence of valid operations
- Nonce Replay: Property test that the same nonce cannot be used twice within TTL
- Use fast-check to generate random operation sequences (reserve, consume, expire)
- **AC:** Conservation property holds across 1000+ random operation sequences
- **AC:** Test explicitly names the GT invariant it verifies

#### T-3.4: Add GT-test traceability report
- Create a script or test reporter that maps GT invariant IDs → test file:line
- Output: "INV-1 → tests/finn/ground-truth/billing-invariants.test.ts:15"
- This closes the loop: GT claims → YAML → tests → traceability report → GT claims
- **AC:** Report shows which invariants have executable tests and which don't
- **AC:** Coverage target: all billing invariants (INV-1–5) + credit conservation

---

## Sprint 4: GT Immune System — Staleness Detection + Drift Monitoring

**Goal:** Transform GT from passive documentation to an active immune system that detects drift, staleness, and cross-repo inconsistency. This implements REFRAME-1 and SPECULATION-3 from the Bridgebuilder review.

**Findings addressed:** reframe-1 (GT as immune system), speculation-3 (cross-repo GT federation)
**Risk:** Medium — staleness detection requires git blame analysis; federation is aspirational
**Dependency:** Sprint 2 (YAML format enables programmatic analysis)
**Connection:** Completes the autopoietic loop — the system monitors its own documentation health

### Tasks

#### T-4.0: Standardize GT citation format
- Define a canonical citation grammar: `path/to/file.ts:L12` (single line) or `path/to/file.ts:L12-L34` (range)
- Update all GT spoke files (api-surface.md, architecture.md, behaviors.md, contracts.md) to conform
- Add citation format validation to `ground-truth-gen.sh --mode validate` (regex check)
- **AC:** All `file:line` citations in GT conform to the canonical grammar
- **AC:** Validator rejects non-conforming citations with clear error messages
- **AC:** Staleness/drift scripts (T-4.1, T-4.2) operate on the standardized format only

#### T-4.1: Create staleness detection script
- Create `scripts/gt-staleness-check.sh` that:
  - Reads `contracts.yaml` (or parses `contracts.md` for standardized `file:line` citations)
  - For each citation, runs `git log --follow -1 --format=%H -- <file>` to get last modification
  - Compares against GT file's last modification date
  - Reports: FRESH (code unchanged since GT written), STALE (code changed, GT not updated), MISSING (cited file no longer exists)
- **AC:** Script outputs a table: invariant ID, source file, staleness status, days since last code change
- **AC:** Script exits non-zero if any invariant cites a missing file

#### T-4.2: Create drift detector
- Create `scripts/gt-drift-check.sh` that:
  - Compares GT line-range citations against current file content
  - Detects when cited line ranges have shifted (function moved, file refactored)
  - Detects when cited functions no longer exist at the stated location
  - Reports: ALIGNED (citation still accurate), SHIFTED (content moved but exists), BROKEN (content no longer exists)
- Use `git blame` + function signature matching for intelligent drift detection
- **AC:** Script detects when a cited function has been moved or renamed
- **AC:** Script runs in < 30 seconds for all GT citations

#### T-4.3: Add GT health check to CI
- Create `scripts/gt-health.sh` that combines staleness + drift checks
- Output format compatible with existing `ground-truth-gen.sh --mode validate`
- Exit codes: 0 = healthy, 1 = stale (warning), 2 = broken (error)
- Wire into `.github/workflows/ci.yml` as a new job `gt-health` that runs on `pull_request` to `main` with `continue-on-error: true` (advisory, not blocking — per Loa convention that documentation drift is informational, not a release blocker)
- **AC:** PR check named `GT Health` appears in GitHub status checks with non-blocking behavior
- **AC:** Health check results visible in PR status checks (pass/warn/fail with summary)

#### T-4.4: Cross-repo invariant index (federation seed)
- Create `grimoires/loa/ground-truth/ecosystem-invariants.md` documenting:
  - loa-finn invariants: INV-1–5 (billing), WAL (5), Auth (5), Credit (2), etc.
  - Hounfour invariants: 73 constitutional constraint files (referenced by schema URI)
  - Dixie invariants: INV-009–012 (freshness, citation, chain, three-witness)
  - Freeside invariants: I-1–5 (conservation guards)
- Include cross-references: "loa-finn INV-4 (cost immutability) enforced at protocol level by hounfour constraint `BillingInvariant.constraints.json`"
- This is the seed document for full cross-repo federation (SPECULATION-3)
- **AC:** Document lists invariants from all 4 ecosystem repos with cross-references
- **AC:** Each cross-reference includes repo + file path for verification

#### T-4.5: Update GT index and checksums
- Add all new files to GT index (contracts.yaml, ecosystem-invariants.md)
- Add staleness/drift/health scripts to GT tooling documentation
- Run final `ground-truth-gen.sh --mode validate`
- Regenerate checksums
- **AC:** Index complete, checksums match, all validation passes

---

## Success Metrics

| Metric | Target |
|--------|--------|
| GT invariants with failure modes | ≥ 12 of 35 (all billing + WAL + credit) |
| Machine-readable invariants (YAML) | 35/35 |
| Property tests from GT | ≥ 5 (INV-1, INV-3, INV-5, credit sum, nonce replay) |
| Staleness detection coverage | All `file:line` citations in GT |
| Cross-repo invariant coverage | 4 repos (finn, hounfour, dixie, freeside) |
| GT health check in CI | Running as advisory check |

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Token budget exceeded on enriched contracts.md | Medium | Low | Create separate failure-modes.md spoke if needed |
| YAML schema conflicts with hounfour constraints | Low | Medium | Align with hounfour's existing schema; prefix finn-specific fields |
| Property tests duplicate existing test coverage | Medium | Low | Audit existing tests first; GT tests verify invariants, not implementations |
| Git blame analysis too slow for CI | Low | Medium | Cache results; only check changed files in PR |
| Cross-repo invariant references go stale | High | Low | Document as point-in-time snapshot; staleness check for local refs only |

## Dependencies & Blockers

- **No external blockers** — all work is within loa-finn repo
- Sprint 2 depends on Sprint 1 (failure modes inform YAML schema)
- Sprint 3 depends on Sprint 2 (YAML enables test generation)
- Sprint 4 partially depends on Sprint 2 (YAML enables staleness analysis), but T-4.4 is independent
