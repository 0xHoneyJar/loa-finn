# Sprint Plan: The Corpus Engine — V1

**Status:** Draft
**Date:** 2026-06-14
**Cycle:** cycle-053
**Supersedes (active slot):** `sprint.archived-2026-06-14-pre-corpus-engine.md` (preserved)
**Traces:** `grimoires/loa/prd.md` (Rev 2) · `grimoires/loa/sdd.md` (Rev 2, §10 overrides) · flatline consensus (PRD + SDD)

> V1 = "Loop + survival re-settle." Deterministic-first phasing (Path B before Path A). Every AC bakes in the flatline §10 fixes. Cross-repo dune-meter fix is the blocking foundation.

---

## Sprint 1: Phase a — Deterministic foundation (the cheap floor first)

**T1 — Fix `dune-meter` (governed headless Dune).** *(cross-repo: loa-freeside)*
- AC1: `dune-meter run <sql> --cap <N> --engine small --json` executes via create-query→execute-by-id (no more HTTP 405) and returns `{executed, credits_consumed, execution_id, atom...}`.
- AC2: bin is executable; `DUNE_METER_BIN` resolves it (the `src/research/sensors/dune.ts` contract).
- AC3 (DD-10): version pinned; golden contract test on the JSON; strict output-schema validation; failure taxonomy — 429 = retryable-with-backoff, budget-refuse/cap-abort = terminal→censored.
- ⚠ Cross-repo: lands in loa-freeside, not loa-finn. Sequencing risk D1.

**T2 — `--mock` data-source mode in the dune sensor (flatline H4/DD-2).**
- AC: `src/research/sensors/dune.ts` accepts `mock: true` returning fixture series; Path B + all schema/orchestration tests run with zero live Dune calls. Unblocks dev while T1 lands.

**T3 — Graduate GADGET #001 → `src/research/realness-verdict.ts`.**
- AC: module moved from `grimoires/loa/lab/gadgets/`; vitest grep roots extended to cover it; discrimination test green (Kintara→REAL, x402→THEATER) in CI.

**T4 — `src/corpus/settle.ts` deterministic core (Path B).**
- AC1: pipeline dune-meter(query) → `realness-verdict` → spine append, metered (cost atom, Contract A).
- AC2 (DD-3): a settle with NO prior registered `tetlock-forecast` is REJECTED.
- AC3 (DD-5/DD-10): settle record stores full provenance incl. the FULL resolved SQL text (blob, ref by `sql_template_hash`) + `verdict_module_sha` + `data_window`.
- AC4: replay of SETTLE-003 (mock or live) reproduces `HELD[real]`; `verifySpineChain()` passes.

---

## Sprint 2: Phase b — Scheduled fresh settle (Path A thin)

**T5 — `src/corpus/intake.ts` transactional candidate store (FR-6/DD-11).**
- AC1: SQLite-backed (via `src/cron/store.ts`); `enqueueCandidate`/`rejectCandidate` ledger source + rejection reason.
- AC2: candidate lifecycle is append-only events with DERIVED status (not one mutable flag).
- AC3 (§6′): per-source quota + source auth — a firehose cannot flood the global budget.

**T6 — `src/corpus/budget.ts` transactional reserve (DD-9/NFR-6).**
- AC1: `reserveBudget(cap)` is atomic (SQLite tx) — concurrent jobs cannot all pass and overspend (TOCTOU test).
- AC2: actual atom cost settles/refunds the reservation; one cost-ledger entry per run.
- AC3 (DD-6): a cap-abort/refuse writes a typed `censored` event (not a silent drop).

**T7 — `src/corpus/engine.ts` + cron wiring + Path-A SettleIntent (FR-1/DD-8/DD-4′).**
- AC1: `registerCorpusJobs` schedules dispatch via `src/cron`; operator-seeded candidate runs `lab-cycle` in a Railway Sandbox (Finn-native fallback behind flag).
- AC2 (DD-8): the sandbox has ZERO spine write access; it emits a schema-validated `SettleIntent`; the HOST validates+meters+commits.
- AC3 (DD-4′): idempotency key = `(candidate_id, horizon)` ordinal, never the dynamic window.

---

## Sprint 3: Phase c — Survival re-settle (the "realness ≠ survival" core)

**T8 — `src/corpus/resettle-queue.ts` (FR-3/DD-3′/DD-4/DD-11).**
- AC1: a `HELD[real]` settle upserts durable `CorpusResettleJob` rows for t+7/t+30/t+90 (idempotent).
- AC2 (DD-4): each re-settle queries a FRESH forward-rolling window `[discovery..now]`, same pinned thresholds + versioned template — never the original window.
- AC3 (DD-3′): each horizon scores its OWN `p_survival_{7,30,90}d` forecast; a re-settle with no horizon forecast is a ground-truth observation (no Brier), never mis-scored against the discovery `p`.
- AC4 (DD-10): all Dune calls flow through ONE global single-concurrency rate-limited queue (no 429 thundering herd).

---

## Sprint 4: Phase d — Calibration + benchmark (the franchise)

**T9 — `src/corpus/calibration.ts` track-record read (FR-4).**
- AC1: returns `{n_settled, n_candidates, funnel_rate, hit_rate, mean_brier_ppm (per horizon), survival_curve{t7,t30,t90}, censored_rate}`.
- AC2: Brier state machine — only binary scored outcomes in the denominator; INSUFFICIENT/INDETERMINATE/censored excluded from Brier but counted in censor-rate + funnel.

**T10 — Discrimination benchmark ≥10 cases (FR-7/C3).**
- AC: ≥10 diverse, independently-known REAL/THEATER cases; false-REAL/false-THEATER rates recorded; thresholds locked; autonomous wiring GATED on green.

---

## Cross-cutting

**T11 — Hostile-input hardening (§6′/NFR-5).**
- AC: parameterized SQL only (no candidate-text interpolation into queries); no shell interpolation; deny-by-default egress in the Path-A sandbox; input schema + length caps; log redaction; injection test-cases blocked.

**T-E2E — End-to-end.**
- AC: seed candidate → forecast → settle → schedule re-settles → (advance clock, mock) re-settle → calibration read; spine chain verifies; no double-settle under a simulated transport death (idempotency).

---

## Dependencies

T1 → T4 · T2 → T4 (mock unblocks) · T3 → T4 · T4 → T5,T6,T7 · T6 → T7 · T7 → T8 · T8 → T9 · T9 → T10 · T11 cross-cuts T4/T7 · T-E2E last.

## Verification per phase
- a: `settle.ts` replays SETTLE-003 (mock) → HELD[real]; chain verifies.
- b: a seeded candidate settles with forecast + provenance; budget reserve is race-safe.
- c: a re-settle produces a survival label on a fresh window with its horizon forecast.
- d: track-record read returns; benchmark ≥10 green.

## Notes
- **T1 is cross-repo (loa-freeside)** — may land as a separate PR; T2 `--mock` keeps loa-finn unblocked meanwhile.
- App-zone code (`src/corpus`, `src/research`) — all via `/implement` under `/run sprint-plan` (no direct implementation).
- Railway Sandbox verified available (2026-06-14); experimental → Finn-native fallback behind a flag.

---

## Flatline sprint hardening (Rev 2 — authoritative overrides)

Source: `a2a/flatline/sprint-corpus-engine-consensus.md`. These override the above where they conflict.

**New tasks (do these first):**
- **T0a — Schema migrations (SP-6).** Versioned, idempotent migrations for ALL new tables (intake, budget, resettle-jobs, provenance) before any module that uses them; rollback notes; fixture-DB test. Prereq for Phase b.
- **T0b — Forecast-registration contract (SP-5).** Define + test `tetlock-forecast` registration: discovery `p` AND `p_survival_{7,30,90}d`, schema, ledger linkage, negative tests (missing/wrong horizon). Prereq for T4.

**Sequencing fixes:**
- **SP-1:** T4 is **mock-only until T6** (budget reserve) lands — no live metered settle before the cap exists. New dep: T6 → (T4 live).
- **SP-2:** the global single-concurrency rate-limited Dune queue moves to **Phase a, inside `src/research/sensors/dune.ts`** (shared by T4/T7/T8), not T8-only. New dep: it's part of T1/T2.
- **SP-3:** T1 gains an AC — a loa-finn CI **contract test invoking the real `DUNE_METER_BIN`** (pinned version) gates acceptance of any live settle; add artifact version-bump/ingestion.

**AC refinements:**
- **T8 / DD-4′ (SP-4, determinism):** re-settle window END = the FIXED horizon target (`discovery+{7,30,90}d`), NOT `now` — deterministic and retry-safe (a 12h-late retry runs the identical query). Supersedes "[discovery..now]".
- **T6 (SP-8):** budget reservations carry a TTL; a sweep job auto-refunds stale uncommitted reserves (crash/OOM/sandbox-hang safety).
- **T8 (SP-9):** a terminal-death signal (e.g. liquidity zeroed) early-cancels remaining re-settles and locks the failed state across the unrun Brier horizons (no wasted budget).
- **T7/T11 (SP-7):** sandbox guarantees are EXECUTABLE tests — sandbox token cannot write the spine, a blocked-egress attempt fails, the fallback path is exercised, host-only commit proven.
- **T10 (SP-11):** benchmark = a fixture manifest with per-case provenance, frozen expected labels, a locked threshold hash; CI fails on fixture/threshold mutation.

**New cross-cutting task:**
- **T12 — Observability (SP-10).** Structured metrics + log assertions + a trace fixture per event type (429/backoff, cap-abort, censored, queue depth, reserve/refund, idempotency replay, calibration exclusion) + redaction tests.

**Revised dependency head:** T0a, T0b → T1/T2 (with shared Dune queue) → T3 → T4(mock) ; T6 → T4(live) → T5,T7 → T8 → T9 → T10 ; T11,T12 cross-cut ; T-E2E last.
