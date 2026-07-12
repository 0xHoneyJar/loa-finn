---
title: G1 self-legibility probe — measurement record (T3.1)
date: 2026-07-12
status: settled-measurement
task: bd-1vp7
fixtures: grimoires/loa/lab/probe-fixtures.yaml (schema_version 1)
results_ledger: grimoires/loa/lab/probe-results.jsonl
---

# G1 probe — measured vs baseline

**Baseline (2026-07-12 morning):** answering "what is finn for / what's built /
what's proven / where from" took THREE multi-agent archaeology workflows
(reality-check sweep, lineage dig, construct consultation) ≈ **1.8M subagent
tokens** across ~17 agents, spanning most of a working day.

**Run #1 (fresh subject, pre-fix):** 4/4 dimensions present with correct
citation classes; **FAIL** — 6/54 citations format-illegal (single-line `:Ln`
and comma-lists). Recorded honestly; gap fixes: `:Ln` sugar in the grammar +
the README now teaches the citation grammar.

**Run #2 (fresh subject, uncontaminated):** **PASS — 37/37 citations resolve**
(`grimoires/loa/context/2026-07-12-g1-probe-answer.md`, validated by
`src/lab/shop/probe.ts`). Cost: ~99 seconds, ~88.6K tokens, 5 files opened
(README routed the subject to the ledger, lineage, SETTLES, and inventory).

**Verdict: G1 MET.** Self-legibility improved ~20× by token cost and from
day-scale to minutes, with mechanical validation instead of spot-checks.
Regression guard: `npm run shop:check` + the probe re-run on identity-doc
changes (trigger set: README.md, grimoires/loa/BEAUVOIR.md,
grimoires/loa/lab/GADGETS.md, grimoires/loa/lore/lineage.md,
grimoires/loa/lab/probe-fixtures.yaml).
