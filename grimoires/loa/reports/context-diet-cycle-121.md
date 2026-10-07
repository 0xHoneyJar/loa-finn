# Context Diet — Cycle-121 Measurement Report

> **Cycle**: cycle-121-claude5-context-diet · **Run**: run-20260729-68d1b75c (autonomous `/run sprint-plan`, 5 sprints, all review+audit APPROVED)
> **Basis**: 2026-07-29 context-engineering audit (workflow `wf_f9c99bce-302`: 112 findings, 41 removal candidates adversarially verified → 21 SAFE / 10 SAFE_WITH_MECHANISM / 8 RISKY / 2 KEEP). Only SAFE-verdict findings (plus behavior-preserving hygiene) were implemented. Branch: `feat/cycle-121-context-diet`, 28 commits, 155 files, +2,628/−18,196 lines.

## Per-tier before → after

| Tier | Before | After | Δ |
|------|--------|-------|---|
| Always-loaded (CLAUDE.md + CLAUDE.loa.md) | 30,309 B (~7.6K tok/turn) | 25,938 B (~6.5K tok/turn) | **−14.4%** |
| `.claude/protocols/` | 519,726 B / 57 files | 279,821 B / 30 files | **−46.2% / −27 files** |
| `.claude/loa/reference/` | 113,005 B / 15 files | 93,766 B / 12 files | −17.0% |
| Skills `SKILL.md` (loads whole on invocation) | 577,461 B | 544,926 B | −32.5KB (+ ~44KB moved to on-demand `resources/`) |
| `grimoires/loa/NOTES.md` | 48,115 B | 7,140 B | −85% (verbatim archive) |
| Dead semantic-memory subsystem | ~107KB code+docs | 0 | deleted (observation migrated to lore) |
| Memory write-surfaces per session | ~12 | ~6 | consolidated |

## What was deleted/shrunk (verdict citations)

- **Sprint 1 — dead weight** [SAFE: dead-protocols, index.yaml-blocks, attention-budget¹, recursive-context+semantic-cache, context-editing+memory, context-compaction, ck-merge, stale artifacts]: 22 protocol files deleted (13 unreachable + old-model context family + ck trio merged into citations.md), 2 mechanism docs folded into references, 2 orphan references deleted, 2 caller-free validators retired, all validator couplings same-commit (`check-loa.sh`, `validate-ck-integration.sh`), 69KB `.bak` skills artifacts removed. ¹mechanism = same-commit validator edits.
- **Sprint 2 — shrink-in-place** [SAFE: tool-result-clearing, karpathy-protocol, structured-memory; + pointer-map rewrite]: five files 44KB → 12.6KB at unchanged paths; the two sanctioned CLAUDE.loa.md Karpathy wording fixes (heading scope; ask-vs-autonomy reconciliation).
- **Sprint 3 — memory consolidation** [SAFE: semantic-memory ×3, memory-inject, structured-memory]: subsystem deleted end-to-end with 6 consumer scripts surgically trimmed; NOTES.md junk writer dead by default + test-guard; NOTES KF-treatment (INDEX `## notes` family, archive-cycle rotation step); KF recurrence signal machine-parseable (KF-004 leads ≥28; `op_recur` handles leading-integer prose; index WARNs on `?`).
- **Sprint 4 — skills dedup/splits** [SAFE: zone one-liners, motivational prose, generic methodology; + behavior-preserving dedup]: 44 boilerplate blocks single-sourced (`generate-skill-includes.sh`, byte-identity migration gate, drift-failing check, fixture-isolated tests); run-mode/simstim/discovering-requirements split to `resources/` (verbatim moves; default-OFF features dominate); Flatline ×3 collapsed; orchestrator frontmatter disambiguated.
- **Sprint 5 — always-loaded diet** [SAFE: post-PR, safety-hooks ×2, merge M3-M5 as scoped, root CLAUDE.md, conventions; MAY-grants via the now-proven registry mechanism]: Post-PR → 2 lines (bridge-pending-bugs contract preserved); Safety Hooks → 3 lines (fence-not-boundary + all-modes preserved); M3–M5 + C-PERM-001..004 registry-rendered at point of use (AGENTS.md projection verified: M1/M2 rows intact); root CLAUDE.md boilerplate + stale-figure trim.

## Explicitly NOT touched (Scope Contract — RISKY/KEEP verdicts)

Karpathy CLAUDE.loa.md section (beyond the two wording fixes) · Agent Teams section/table (verifier demonstrated 4 live hook bypasses) · Read-before-Write row (#1177-F telemetry needs re-measurement) · TaskCreate-vs-beads rows (harness counter-nudges are live — observed repeatedly during this very run) · /spiraling why-text (C-PROC-017, Bash bypass class) · Multi-Model/Tiered prose (lint-time-only coverage; KF-019) · reviewing-code minimum-quota (KF-004 rec ≥28) · Backpressure DO-NOTs · grounding-enforcement.md.

## Deferred SAFE_WITH_MECHANISM backlog (follow-up cycle `mechanical-floor-extensions`)

1. Wire `implement-gate.sh` (built, tested, parked) → then N1/N3/A1/A4 prose collapses
2. FR-SZ `.claude/` root in block-destructive-bash (Bash writes to System Zone un-fenced single-agent)
3. `git tag` fence (currently allowlisted; M2 prose is the only guard)
4. Stash-swallow patterns (`git stash … | tail`, `|| true`) → then stash-safety.md shrinks
5. `/bug` eligibility validator → merge N5+A5 rows
6. C-BRIDGE-001..008 skill-md render + post-compaction SKILL.md re-surfacing routing row → then Bridge table relocates
7. Agent-Teams constraint surfacing hook (or mechanical LOA_TEAM_MEMBER injection) → then section shrinks
8. Land ≥0.95 grounding-ratio in review skills' inline blocks → then grounding-enforcement.md disposal
9. Re-measure Read-before-Write error rate under Opus 5/Fable 5
10. post-merge.yml unattended agent: model upgrade + C-MERGE render into its prompt
11. run-mode residual split to ≤28KB (recovery procedures deliberately kept inline this cycle)
12. NOTES.md.template `## Decisions` vs validator `## Decision Log` alignment (bd-a3ks)

## Known pre-existing conditions (documented, not caused by this cycle)

- `check-loa.sh` integrity section red in the dev repo since the 2026-01-17 manifest (mount-time regeneration is the fix; deleted-file rows were removed, rationale in NOTES Decision Log).
- `tests/integration/` has pre-existing failures identical on main (ledger-workflow 24, check-updates 8, gpt-review-skills 6, …) — outside CI's bats gate.
- validate-constraints 1 WARN: `agent_teams_constraints` orphan marker (section untouched by design — RISKY).


---

## Appendix: Cycle-122 "Mechanical Floor Extensions" (stacked follow-up, run-20260729-6751a4d1)

Operator decisions 2026-07-29 executed: items 3-6 green-lit; Karpathy + Read-before-Write delegated with conditions.

| Item | Outcome |
|------|---------|
| implement-gate.sh | WIRED (both settings files; 14/14 suite; fail-ASK) — N1/N3 + A1/A4 rows consolidated registry-clean |
| git tag fence (FR-MERGE-2) | Live; allowlist entry removed; listing/delete forms allowed; audited override |
| stash-swallow fence (FR-1.2b) | Live incl. ANY /dev/null redirect (round-2 dissenter fix — the live-incident shape); stash-safety.md shrunk to interface+judgment |
| System-Zone Bash fence (FR-SZ2) | Live; honors the bounded zone-guard marker; overrides/+cache/ excluded; traversal-guarded (round-2 dissenter fix) |
| post-merge agent | claude-sonnet-5 + C-MERGE constraints in prompt + violation-stop clause |
| post-compaction skill-context | Active-skill re-surfacing (run-mode/run-bridge/simstim), state-sets grounded in stop-guard gates (round-2 dissenter fix), 8/8 bats |
| C-BRIDGE render | All 8 rules registry-rendered in run-bridge/SKILL.md (004/007/008 first time at point of use); CLAUDE.loa.md table -> routing paragraph |
| Karpathy trim (delegated) | APPLIED after unanimous 3/3 parity gate (round 1 was 2/3 — two dropped obligations RESTORED); -333 B/turn; every pinned clause byte-preserved; judge journals in a2a/sprint-3/parity-audit/ |
| Read-before-Write (delegated) | KEPT — condition unmeetable without fleet telemetry; flip-evidence recorded (NOTES Decision Log + swm-rbw-remeasure) |
| bd-a3ks | Template heading aligned; fresh mounts no longer WARN |

**Always-loaded after cycle-122: 24,465 B** (cycle-121 start: 30,309 B → cumulative **−19.3%**), with MORE enforcement than before (4 new/wired fences).

Remaining deferred (unchanged verdicts): Agent-Teams surfacing (needs design discussion), grounding-ratio landing, /bug eligibility validator, run-mode residual split, RISKY/KEEP items.
