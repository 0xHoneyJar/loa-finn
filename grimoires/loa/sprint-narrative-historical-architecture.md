---
status: Draft
date: 2026-07-12
bead: bd-1vp7
traces: prd-narrative-historical-architecture.md (rev 2) · sdd-narrative-historical-architecture.md (rev 2)
hivemind:
  schema_version: "1.0"
  artifact_type: product-spec
  product_area: "loa-finn — Finn's Shop sprint plan (4 sprints: substrate → protocol → probe → CLI v0)"
  workstream: experimentation
  priority: high
  jtbd: {category: functional, description: "sprint decomposition with mechanical ACs incl. negative tests; S4 gated on S1-S3 acceptance"}
  learning_status: directionally-correct
  source: team-internal
---

# Sprint Plan — Finn's Shop (bd-1vp7)

> 4 sprints. Every task has pass/fail ACs including NEGATIVE tests (SDD §6).
> Code tasks run through /implement inside /run; doc tasks are grimoire-zone.
> S4 is GATED: begins only when S1–S3 ACs are green via the aggregate runner.

## Sprint 1 — Identity + ledger substrate (FR-1, FR-2, FR-3 + two tools)

**T1.1 — cite-check.ts** (`src/lab/shop/cite-check.ts`, ~180 loc + tests)
- Parses citation forms: `path`, `path:Lx-Ly`, `path@sha`, `path:Lx-Ly@sha`, `commit:<sha>`, `ledger:<row-id>`.
- Resolution per SDD 2.5 semantics (git-anchored, dirty/moved/dead distinct).
- AC+: fixtures resolve; JSON report shape versioned.
- AC−: dangling path → `dead` + exit 1; drifted range → `moved` + exit 1; dirty working-tree target → `dirty` + exit 1; unknown schema_version in report request → reject; symlinked path → not followed, `dead`.

**T1.2 — ledger-check.ts** (`src/lab/shop/ledger-check.ts`, ~120 loc + tests)
- Parses GADGETS.md YAML block; validates closed enums + check-runner schema (vitest|node-script|py-compile, argv list, in-repo target); reconciles boundary enumeration ↔ rows (SDD 2.2 rules); `--render` regenerates the human table.
- AC+: seeded ledger reconciles; render is idempotent.
- AC−: free-string `cmd` field → reject; out-of-root `home` → reject; duplicate id → reject; unenrolled instrument on disk → exit 1 naming it; phantom row → exit 1; stale rendered table → exit 1.

**T1.3 — GADGETS.md seeded** (grimoire)
- Rows: gadget-001 realness-verdict; metabolism instruments (solver/cartographer, loyal-traitor, oracle, hand, population-ledger, metabolism-ledger, verify); the four shop tools themselves (LOC ceilings in rows); candidates #002/#003 as CANDIDATE.
- Lifecycle section (FR-6) in the header.
- AC: `ledger-check` exit 0; every non-pending row's check runs green under its contract.

**T1.4 — claim-inventory.yaml + identity truth-repair** (grimoire + README/BEAUVOIR)
- Load-bearing identity claims enumerated with citations; README "production-shaped use" line replaced with cited truth; BEAUVOIR.md + README "Why Finn" updated to the shop thesis (lineage-cited).
- AC+: `cite-check` over the inventory → exit 0.
- AC−: a deliberately-broken fixture inventory fails.

**T1.5 — lore/lineage.md** (grimoire)
- The archaeology as governed doc: README lives, PRD arc, handoff record (custody grant summarized — vault boundary: no verbatim), cosmology chain; links roster/jani.md + testimony.
- AC: every claim carries a citation; `cite-check` over the doc → exit 0.

## Sprint 2 — Consultation protocol + corpus intake (FR-4, FR-5 + two tools)

**T2.1 — corpus-scrub.ts** (~60 loc + tests)
- Applies flatline secret_scanning patterns; writes manifest.yaml (sha256 raw+redacted, counts); deletes raw post-scrub (SDD retention).
- AC+: fixture export with planted secrets → all redacted, manifest correct, raw gone.
- AC−: pattern miss on a known-format secret fixture → test fails; manifest hash mismatch → exit 1.

**T2.2 — lab/corpus/ + INTAKE.md** (grimoire)
- Convention doc (redaction gate, provenance.yaml tiers, guards[], internal-only); operator-gated items listed `DONE | OPEN(owner: operator)` — export, custody signing, symlink fix.
- AC: convention doc complete; any landed acquisition stamped with tiers; open items owned.

**T2.3 — CONSULTATIONS.md protocol** (grimoire)
- The JANI-v0 shape codified; deterministic-vs-LLM boundary table (SDD 2.3); confidence derivation rules v1; testimony frontmatter schema; ethics-header requirement for person subjects.
- AC: protocol validates against the JANI testimony retroactively (its citations resolve; confidence fields re-derive).

**T2.4 — probe.ts + fixtures** (~120 loc + tests)
- `lab/probe-fixtures.yaml` (4 dimensions → required citation classes, versioned); probe run appends to `lab/probe-results.jsonl`.
- AC+: a correct answer file passes; result line appended, versioned.
- AC−: answer missing a dimension's citation class → fail; answer with dangling citation → fail; unknown fixtures_version → reject.

**T2.5 — Consultation #2 (G2)** (grimoire — subject: repo-lineage or a decision, NOT a person; internal)
- Run through CONSULTATIONS.md verbatim: pre-registered questions → miners → cited verdicts → testimony record.
- AC: testimony VALID per protocol (cite-check green, confidences re-derive); at least one honest ABSTAIN or the absence justified.

## Sprint 3 — The measurement (G1) + CLI spec ratification (FR-8)

**T3.1 — Probe run vs baseline**
- Fresh session given the 4 fixtures; answer validated by probe.ts; run recorded next to the 2026-07-12 baseline (3 workflows ≈ 1.8M tokens) in a testimony-convention record.
- AC: probe exit 0 with all citations resolving; tokens/minutes recorded. (If it FAILS, the failure report is the sprint output — the gap list drives fixes; honest fail ≠ sprint fail.)

**T3.2 — Regression trigger set**
- Declared glob list (identity docs, GADGETS.md, lineage, fixtures) + a local runner (`npm run shop:check` = ledger-check + cite-check over inventory/lineage + probe re-validation of last answer) wired into CI when touched.
- AC+: runner green end-to-end.
- AC−: mutating a ledger row to free-string cmd breaks CI; breaking an inventory citation breaks CI.

**T3.3 — finn-cli spec ratified** (grimoire: `grimoires/loa/specs/finn-cli-v0.md`)
- Per-verb I/O + privacy filter + error semantics (SDD 2.6 table expanded); every verb maps to an artifact that now EXISTS; Loa-launcher slot-in noted as V2.
- AC: spec review pair-point with operator; each verb's reads verified against real files.

## Sprint 4 — finn-cli v0 (FR-9) — GATED on S1–S3 aggregate green

**T4.1 — `doctor` + `gadgets` verbs** (bin in-repo, reads only)
- AC+: `finn doctor` table + `--json` against real substrate; exit 1 when a red is planted; `finn gadgets --run-check <id>` executes under the row contract.
- AC−: unknown id → exit 2; `internal-only` corpus content never in any output (refOnly test); no writes anywhere (fs-mock test).

**T4.2 — Probe data needs served**
- `finn doctor` surfaces last probe result from probe-results.jsonl.
- AC: doctor red iff last probe failed or is absent.

## Verification (aggregate)

`npm run shop:check` green + all sprint ACs = Track 1+2 acceptance (PRD §7.5).
Circuit breaker: any tool exceeding its LOC ceiling → split/graduate decision
before merge (FR-7). Everything lands on the cycle branch via /run's
implement→review→audit loop; audit gate enforces the negative-test floor.
