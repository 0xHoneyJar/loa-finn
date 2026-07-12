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
> thesis). Everything here is grimoire docs + three small deterministic TS tools.
> No services, no daemons, no new state stores. The CLI (Track 3) is a READER.

## 1. Architecture overview

```
                         ┌─ identity docs ────────────────┐
                         │ README.md · BEAUVOIR.md         │
                         │ + claim-inventory.yaml          │
   ┌─ corpus ──────────┐ ├─ ledgers ──────────────────────┤     ┌─ tools (deterministic) ─┐
   │ lab/corpus/       │ │ lab/GADGETS.md (gadget ledger)  │ ◄── │ cite-check.ts (validator)│
   │  intake/ (tiered) │ │ lab/SETTLES.md (existing)       │     │ probe.ts (G1 runner)     │
   │  + redaction gate │ ├─ lineage ──────────────────────┤     │ ledger-check.ts (G3)     │
   └───────────────────┘ │ lore/lineage.md · roster/*.md   │     └──────────────────────────┘
                         │ context/<date>-*-testimony.md   │                ▲
                         └────────────────────────────────┘                │ reads only
                                        ▲                                   │
                          consultations (protocol doc) ──── finn-cli (spec; v0 gated)
```

One flow: **record → cite → check.** Docs hold the truth with citations; the three
tools mechanically verify citations, ledger completeness, and the G1 probe; the
CLI (later) surfaces the same reads as verbs.

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
# ledger.yaml block schema (v1)
- id: gadget-001-realness-verdict
  what: SETTLE verdict math as a pure module
  status: KEEP            # CANDIDATE | KEEP | SELL | THROW  (closed vocab)
  home: grimoires/loa/lab/gadgets/realness-verdict
  check: {cmd: "npx vitest run <path>", exit: zero-is-pass, timeout_s: 120, contract: declared}
  graduation: src-imported   # lab-only | src-imported | pending
  evidence: {commit: "…", note: "5/5 green 2026-06-14"}
```

- **Closed discovery boundary** (PRD FR-2): enrollment = `lab/gadgets/*` ∪
  `src/lab/metabolism/*` ∪ explicit rows. `ledger-check.ts` reconciles the
  enumeration against the rows both ways.
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
matches the recorded derivation rule. Person-subject records inherit the ethics
line from roster/jani.md (internal-only, never-as-them, retire-on-objection).

### 2.4 Corpus intake (Track 1, FR-5)

**`grimoires/loa/lab/corpus/`** — `INTAKE.md` (convention) + `intake/<source>/`
dirs. Intake steps (manual, small): (1) drop raw export; (2) run the redaction
gate — reuse `flatline_protocol.secret_scanning.patterns` from .loa.config.yaml
via a ~40-line `corpus-scrub.ts` pass (report + redact in place; third-party
content minimized); (3) stamp `provenance.yaml`: `{source, acquired, tier:
git-verbatim|account-verbatim|captured|claimed, privacy: internal-only, guards[]}`.
Misattribution guards are entries in `guards[]`, carried into any consultation
that cites the source. Operator-gated V1 items tracked in INTAKE.md as
`DONE | OPEN(owner: operator)` — open items narrow the corpus, never block.

### 2.5 The three tools (Track 1-2; small, deterministic, no deps beyond repo)

| Tool | ~size | Contract |
|---|---|---|
| `src/lab/shop/cite-check.ts` | ~150 loc | input: file(s) with citations (`path[:Lx-Ly][@sha]`, `ledger:<row-id>`, `commit:<sha>`); resolves each against the working tree / git; exit 0 iff all resolve; JSON report |
| `src/lab/shop/ledger-check.ts` | ~100 loc | parses GADGETS.md YAML block; reconciles boundary enumeration ↔ rows; validates closed vocab + check contracts; exit 0 iff reconciled |
| `src/lab/shop/probe.ts` | ~120 loc | loads probe fixtures (`lab/probe-fixtures.yaml`: 4 dimensions → required citation classes); given a probe ANSWER file, runs cite-check on it + asserts each dimension's required classes present; exit 0 = probe pass |

All three: vitest-covered, integer/boolean outputs, no LLM, no network. They ARE
gadgets — enrolled in the ledger with their own checks (the shop's tools live on
its own shelves).

### 2.6 finn-cli (Track 3 — SPEC in this cycle; v0 build gated)

Contract (absorbs flatline root E):

| Verb | Reads | Output | Errors |
|---|---|---|---|
| `finn doctor` | claim-inventory + GADGETS + corpus provenance + probe fixtures | health table: identity claims resolve? ledger reconciled? corpus tiers? last probe result | exit 1 on any red; `--json` for tooling |
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
(`{dimension, question, required_citation_classes[]}`). Where shapes touch the
Corpus Engine's substrate (settle verdicts, calibration), its schemas are
canonical (PRD §6 sibling precedence) — this cycle only READS them.

## 4. Security & privacy

- Intake redaction gate before anything enters corpus (2.4); secret patterns
  reused from flatline config — one pattern SoT.
- `internal-only` provenance is enforced at the two egress points: consultation
  testimony (citations only, no raw bodies) and CLI output (privacy filter, 2.6).
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
S2 Consultation protocol + corpus intake (FR-4..5 + probe + consultation #2) →
S3 Probe run vs baseline + CLI spec ratification (FR-8; G1 measured) →
S4 (gated) finn-cli v0 `doctor`+`gadgets` (FR-9).

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
