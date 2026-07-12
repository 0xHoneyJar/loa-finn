---
status: Draft
date: 2026-07-12
bead: bd-1vp7
traces: grimoires/loa/prd-narrative-historical-architecture.md (rev 2, flatline A-D folded)
sibling: grimoires/loa/sdd.md (Corpus Engine — its schemas are canonical where shared)
hivemind:
  schema_version: "1.0"
  artifact_type: technical-rfc
  product_area: "loa-finn — Finn's Shop SDD: identity substrate, gadget discipline, CLI seam"
  workstream: experimentation
  priority: high
  jtbd: {category: functional, description: "the smallest honest design that makes finn self-legible: four doc substrates + three small deterministic tools + one CLI contract"}
  learning_status: directionally-correct
  source: team-internal
---

# SDD — Finn's Shop: Narrative & Historical Architecture

> **Software Design Document.** Design law: minimalism as enforced shape (the k3s
> thesis). Everything here is grimoire docs + four small deterministic TS tools
> (~480 loc total). No services, no daemons, no new state stores beyond one
> append-only probe-results ledger. The CLI (Track 3) is a READER.

## 1. Architecture overview

```
                         ┌─ identity docs ────────────────┐
                         │ README.md · BEAUVOIR.md         │
                         │ + claim-inventory.yaml          │
   ┌─ corpus ──────────┐ ├─ ledgers ──────────────────────┤     ┌─ tools (deterministic) ─┐
   │ lab/corpus/       │ │ lab/GADGETS.md (gadget ledger)  │ ◄── │ cite-check.ts (validator)│
   │  intake/ (tiered) │ │ lab/SETTLES.md (existing)       │     │ probe.ts (G1 runner)     │
   │  + redaction gate │ ├─ lineage ──────────────────────┤     │ ledger-check.ts (G3)     │
   │  (corpus-scrub.ts)│ │ lore/lineage.md · roster/*.md   │     │ + probe-results.jsonl    │
   └───────────────────┘ │ context/<date>-*-testimony.md   │     └──────────────────────────┘
                         │                                 │                ▲
                         └────────────────────────────────┘                │ reads only
                                        ▲                                   │
                          consultations (protocol doc) ──── finn-cli (spec; v0 gated)
```

One flow: **record → cite → check.** Docs hold the truth with citations; the four
tools mechanically verify citations, ledger completeness, intake hygiene, and the
G1 probe; the CLI (later) surfaces the same reads as verbs.

## 2. Components

### 2.1 Identity substrate (Track 1, FR-1/FR-3)

- `README.md` "Why Finn" + `grimoires/loa/BEAUVOIR.md` → corrected to the
  gadget-forge thesis. Falsified production-claim line replaced with the cited
  truth (56/56 failed deploys, NXDOMAIN).
- **`grimoires/loa/identity/claim-inventory.yaml`** — the load-bearing identity
  claims, one entry each: `{claim, citation: {path, ref}, class: observed|claimed}`.
  This is what makes FR-1's "no contradictions" checkable: cite-check resolves
  every entry.
- **`grimoires/loa/lore/lineage.md`** — the archaeology as governed doc: README
  lives, PRD arc, handoff record (custody grant summarized — vault boundary),
  cosmology chain. Every claim commit-cited. Links to roster/jani.md.

### 2.2 Gadget ledger (Track 1-2, FR-2/FR-6/FR-7)

**`grimoires/loa/lab/GADGETS.md`** — markdown table + a fenced YAML block (the
machine-readable mirror; the table is the human view, the YAML is what tools
parse — one file, no drift between two files):

```yaml
# ledger.yaml block schema (schema_version: 1; closed enums throughout)
- id: gadget-001-realness-verdict
  what: SETTLE verdict math as a pure module
  status: KEEP            # CANDIDATE | KEEP | SELL | THROW  (closed vocab)
  home: grimoires/loa/lab/gadgets/realness-verdict
  check:
    runner: vitest          # CLOSED enum: vitest | node-script | py-compile — NEVER a free shell string
    target: grimoires/loa/lab/gadgets/realness-verdict   # must resolve INSIDE the repo root
    args: []                # argv list, no shell interpolation (injection surface closed)
    exit: zero-is-pass
    timeout_s: 120
    contract: declared      # declared | pending
  graduation: src-imported   # lab-only | src-imported | pending
  evidence: {commit: "…", note: "5/5 green 2026-06-14"}
```

The human table in GADGETS.md is **generated FROM the YAML block**
(`ledger-check.ts --render` rewrites it) — single source, zero drift; a stale
table is a ledger-check failure, not a judgment call.

- **Closed discovery boundary** (PRD FR-2): enrollment = `lab/gadgets/*` ∪
  `src/lab/metabolism/*` ∪ explicit rows. `ledger-check.ts` reconciles the
  enumeration against the rows both ways. Enumeration rules (deterministic):
  depth-1 directories only under `lab/gadgets/`; `.ts` modules (excluding
  `*.test.ts` and `types.ts`) under `src/lab/metabolism/`; symlinks NOT followed;
  rows whose `home` resolves outside the repo root are validation errors;
  duplicate ids are validation errors.
- Legacy instruments may carry `check.contract: pending` — visible debt, never a
  silent exemption.
- **Lifecycle doc** (FR-6): one section in GADGETS.md header — intake → build
  (compose lane, FAGAN-gated) → check → verdict row → graduation via /implement.

### 2.3 Consultation engine (Track 1, FR-4)

**`grimoires/loa/lab/CONSULTATIONS.md`** — the protocol doc. The JANI-v0 shape,
with the epistemic boundary stated as a testable rule:

| Side | Who | Allowed |
|---|---|---|
| RETRIEVE/DRAFT | LLM (miners, weaver) | search, read, assemble candidate evidence + draft verdict text |
| SETTLE | deterministic code | citation resolution (cite-check), confidence derivation (recorded rule: e.g. ≥2 independent primary citations = HIGH), ABSTAIN when citations fail, testimony validity |

Testimony records: `grimoires/loa/context/<date>-<subject>-testimony.md` with
frontmatter `{subject, questions[], verdicts[]: {q, verdict, confidence, citations[]}, corpus_map}`.
A testimony is VALID iff cite-check resolves all citations and each confidence
matches the recorded derivation rule. **Confidence derivation (deterministic,
v1):** citations are *independent* iff they differ in BOTH source artifact and
provenance tier-origin (two captures of one Discord message = one source).
HIGH = ≥2 independent citations with ≥1 at git-verbatim/account-verbatim tier;
MEDIUM = 1 primary OR ≥2 captured; LOW = captured/claimed only; conflicting
citations (evidence on both sides) → ABSTAIN with both cited — never averaged.
Person-subject records inherit the ethics line from roster/jani.md
(internal-only, never-as-them, retire-on-objection).

### 2.4 Corpus intake (Track 1, FR-5)

**`grimoires/loa/lab/corpus/`** — `INTAKE.md` (convention) + `intake/<source>/`
dirs. Intake steps (manual, small): (1) drop raw export; (2) run the redaction
gate — reuse `flatline_protocol.secret_scanning.patterns` from .loa.config.yaml
via a ~40-line `corpus-scrub.ts` pass (report + redact in place; third-party
content minimized); (3) stamp `provenance.yaml`: `{source, acquired, tier:
git-verbatim|account-verbatim|captured|claimed, privacy: internal-only, guards[]}`.
Misattribution guards are entries in `guards[]`, carried into any consultation
that cites the source. **Retention policy:** after the scrub, the RAW export is
DELETED — only the redacted copy + a `manifest.yaml` (per-file sha256 of raw and
redacted, redaction counts by pattern) is retained, so provenance is provable
without holding unscrubbed content. Operator-gated V1 items tracked in INTAKE.md
as `DONE | OPEN(owner: operator)` — open items narrow the corpus, never block.

### 2.5 The four tools (Track 1-2; small, deterministic, no deps beyond repo)

| Tool | ~size | Contract |
|---|---|---|
| `src/lab/shop/cite-check.ts` | ~180 loc | input: file(s) with citations (`path[:Lx-Ly][@sha]`, `ledger:<row-id>`, `commit:<sha>`); exit 0 iff all resolve; JSON report |
| `src/lab/shop/ledger-check.ts` | ~120 loc | parses GADGETS.md YAML block; reconciles boundary enumeration ↔ rows; validates closed enums + check contracts; `--render` regenerates the human table; exit 0 iff reconciled |
| `src/lab/shop/probe.ts` | ~120 loc | loads probe fixtures (`lab/probe-fixtures.yaml`: 4 dimensions → required citation classes); given a probe ANSWER file, runs cite-check + asserts each dimension's required classes; **appends result to `lab/probe-results.jsonl`** (the persisted artifact `finn doctor` reads); exit 0 = pass |
| `src/lab/shop/corpus-scrub.ts` | ~60 loc | redaction gate (2.4): applies secret_scanning patterns + writes manifest.yaml; exit 0 = scrubbed |

**cite-check resolution semantics:** citations with `@sha` resolve via
`git show sha:path` (immune to later rewrites); pathless-SHA citations resolve
iff the commit exists and is an ancestor of HEAD; working-tree citations resolve
against a CLEAN tracked file (dirty target → `dirty` failure, not a pass);
symlinks are not followed; a path that exists with a drifted range reports
`moved`, a missing path/commit reports `dead` — both fail, distinctly.

All four: vitest-covered, integer/boolean outputs, no LLM, no network. They ARE
gadgets — enrolled in the ledger with their own checks and LOC ceilings (the
shop's tools live on its own shelves).

### 2.6 finn-cli (Track 3 — SPEC in this cycle; v0 build gated)

Contract (absorbs flatline root E):

| Verb | Reads | Output | Errors |
|---|---|---|---|
| `finn doctor` | claim-inventory + GADGETS + corpus provenance + `lab/probe-results.jsonl` (persisted — the CLI stays read-only) | health table: identity claims resolve? ledger reconciled? corpus tiers? last probe result | exit 1 on any red; `--json` for tooling |
| `finn gadgets [id]` | GADGETS.md YAML block | list/status/check per gadget; `--run-check <id>` executes the row's check under its contract | exit = check exit; unknown id → 2 |
| `finn consult <subject> -q <file>` | CONSULTATIONS.md protocol + corpus | scaffolds a testimony record (pre-registered questions); SETTLE side calls cite-check | refuses person-subjects lacking an ethics header (privacy filter) |
| `finn settles` | lab/SETTLES.md | list settled verdicts + evidence links | — |

Privacy filter: verbs never print corpus RAW content for `privacy: internal-only`
sources — only citations/metadata (the vault-boundary discipline, mechanized).
Packaging: standalone bin in this repo (like freeside-cli's incur pattern), slots
into the Loa launcher (`loa run finn …`) later — launcher integration is V2+.
v0 build (FR-9, gated on T1+T2 acceptance): `doctor` + `gadgets` only.

## 3. Data models (authoritative shapes)

Defined above in-place: ledger row (2.2), testimony frontmatter (2.3),
provenance.yaml (2.4), claim-inventory entry (2.1), probe fixture
(`{dimension, question, required_citation_classes[]}`), probe result line
(`{ts, fixtures_version, pass, dimensions: {..}, validator_report_path}`).
Every shape carries `schema_version: 1` with closed enums; validators reject
unknown versions/fields (fail-closed compat). **Sibling consumption pinned:**
this cycle reads exactly two Corpus Engine artifacts — `lab/SETTLES.md`
(verdict entries, display only) and the `gadgets/realness-verdict` module id —
at their in-repo state on this branch; nothing else is imported, and neither is
modified here.

## 4. Security & privacy

- Intake redaction gate before anything enters corpus (2.4); secret patterns
  reused from flatline config — one pattern SoT; raw exports not retained.
- `internal-only` provenance is enforced at EVERY egress, not just testimony and
  CLI stdout: cite-check/probe JSON reports, diagnostics, and check output emit
  citations/metadata only — a shared `refOnly()` formatter is the single place
  corpus content could leak, and its test asserts raw bodies never appear.
- Person-construct ethics: consult verb refuses subjects without an ethics
  header; roster brief is the header's home.
- No network calls in any tool; no new secrets; nothing here touches auth paths.

## 5. Technology choices

TypeScript (NodeNext, vitest) for the three tools — matches the metabolism lane
(bd-ryza locked decision #1); YAML-in-markdown for ledgers (human view + machine
mirror in ONE file); no new dependencies (yaml parser already in repo deps).
Rejected: a database (nothing here needs one), a service (ditto), extending the
Corpus Engine's engine directly (sibling precedence — consume, don't fork).

## 6. Sprint-shaped seams (input to Phase 5)

S1 Identity+ledger substrate (FR-1..3 + cite-check/ledger-check) →
S2 Consultation protocol + corpus intake (FR-4..5 + probe + corpus-scrub +
consultation #2) →
S3 Probe run vs baseline + CLI spec ratification (FR-8; G1 measured) →
S4 (gated) finn-cli v0 `doctor`+`gadgets` (FR-9).

Sprint-plan requirement (flatline): every task carries measurable pass/fail ACs
including NEGATIVE tests — malformed ledger rows, dangling/moved/dirty
citations, out-of-boundary homes, unknown schema versions, redaction misses —
not just happy paths.

## 7. Risks (design-level)

- **Two-representation drift** (table vs YAML block) → mitigated: one file, and
  ledger-check validates the YAML is present and parseable; the table is
  presentation only.
- **Citation rot on rebase/rewrite** → citations prefer commit-SHA-anchored refs;
  cite-check reports `moved` (path exists, range drifted) distinctly from `dead`.
- **Probe gaming** (answers written to fixtures) → fixtures declare citation
  CLASSES, not answer text; the probe subject is a fresh session, and the
  validator checks resolution, not prose.
- **Scope creep into engine-building** → the three tools have LOC ceilings in
  their ledger rows; growth past "small" = split or graduate (FR-7).
