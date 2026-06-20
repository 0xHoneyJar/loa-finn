# SDD: The Corpus Engine — Software Design Document

**Status:** Draft
**Author:** Finn (main-loop)
**Date:** 2026-06-14
**Cycle:** cycle-053
**Supersedes (active slot):** `sdd.archived-2026-06-14-pre-corpus-engine.md` (March Per-NFT SDD, unrelated — preserved)
**Traces:** `grimoires/loa/prd.md` (Rev 2, flatline-hardened) · `a2a/flatline/prd-corpus-engine-consensus.md`
**Rev 2 (2026-06-14):** flatline-reviewed (headless GPT-5.5 + Gemini-3.1-pro). 2 design BLOCKERS + 6 findings folded in — see **§10** (authoritative overrides) and `a2a/flatline/sdd-corpus-engine-consensus.md`.

> Design for automating the realness loop into a scheduled, governed, cost-capped engine that grows a calibration track record. Builds on the EXISTING `src/cron` orchestration + `src/research` probe/spine + the `lab-cycle` composition. Mostly integration.

---

## 1. Architecture overview

The engine has **two dispatch paths**, split by whether the work needs an LLM. This split is the load-bearing design decision — it makes the high-volume work (re-settles) cheap, pure, and cron-trivial, and isolates the expensive/fragile agentic part.

```
                              ┌─────────────────── src/corpus (the engine) ──────────────────┐
 candidate intake (SQLite) ──▶│  scheduler (src/cron) ──▶ dispatch by path:                   │
   • operator-seeded          │                                                                │
   • (fast-follow: grok)      │   PATH A — AGENTIC (new candidate)                             │
                              │     Railway Sandbox → lab-cycle via /compose                   │
                              │       PROBE(OSINT) → REGISTER → DESIGN ⟦pin bars⟧              │
                              │       → forecast(p) → SETTLE(dune-meter) → verdict → spine     │
                              │                                                                │
   re-settle queue ──────────▶│   PATH B — DETERMINISTIC (re-settle / survival) — NO LLM      │
   (forward-rolling t+N)      │     dune-meter(query, fresh window) → realness-verdict         │
                              │       → Brier(vs registered p) → spine append                  │
                              └──────────────┬─────────────────────────────────────────────────┘
                                             ▼
                          spine ledger (append-only, hash-chained)  ──▶  calibration read
                          + bet provenance (NFR-7) + censored outcomes (NFR-6)
```

**Why the split (flatline #2, #10):** re-settle is pure deterministic — the candidate was already probed/designed; survival is just *re-running the same query on a fresh window + scoring*. It needs no agents, no sandbox CLIs, no compose runtime. Path B is therefore cheap, idempotent, and the bulk of scheduled volume. Path A (new candidates) is the only path that needs the heavy agentic composition, and it's lower-frequency (operator-seeded in V1).

---

## 2. Components

| Component | Path | New / Existing | Responsibility |
|---|---|---|---|
| `src/corpus/engine.ts` | both | **new** | Top-level orchestrator; registers cron jobs; routes A vs B |
| `src/corpus/intake.ts` | both | **new** | Transactional candidate store (FR-6); ledger every candidate + rejection reason |
| `src/corpus/resettle-queue.ts` | B | **new** | Forward-rolling re-settle scheduler (t+7/+30/+90); FR-3 |
| `src/corpus/settle.ts` | both | **new** | Deterministic settle: dune-meter query → realness-verdict → Brier → spine; bet provenance (NFR-7) |
| `src/corpus/calibration.ts` | — | **new** | Track-record read: count, hit-rate, mean Brier, survival curve, funnel |
| `src/corpus/budget.ts` | both | **new** | Global rolling (24h) credit budget + censored-outcome accounting (NFR-6) |
| `src/research/realness-verdict.ts` | both | **graduated** | GADGET #001 (from `grimoires/loa/lab/gadgets/`), pure verdict |
| `src/research/sensors/dune.ts` | both | existing | Shells governed `dune-meter` (the D1 fix unblocks it) |
| `src/research/spine-ledger.ts` | both | existing | Append-only hash-chained Ledger of Bets |
| `src/research/schemas/tetlock-forecast.ts` | both | existing | Pre-registered forecast (`probability_ppm`) — FR-4 |
| `src/cron/*` | both | existing | scheduler, runner, idempotency, circuit-breaker, kill-switch, rate-limiter, concurrency, sandbox-policies, store |
| `lab-cycle.yaml` (compose) | A | existing | The agentic loop for new candidates |
| `dune-meter` (loa-freeside) | both | **fix (D1)** | Governed headless Dune: create-query→execute-by-id, `--cap`, JSON+atom |

---

## 3. Key design decisions

**DD-1 — Two-path dispatch (§1).** Agentic (A) vs deterministic (B). Re-settles never touch an LLM or the compose runtime.

**DD-2 — dune-meter is the single Dune chokepoint (FR-2, D1).** Both paths settle through `src/research/sensors/dune.ts` → `dune-meter run … --cap`. No path uses the Dune MCP (absent in headless). The D1 fix (cross-repo loa-freeside): replace the dead `POST /api/v1/query/execute` (405) with create-query-then-execute-by-id, make the bin executable, expose `DUNE_METER_BIN`. **Flatline H4:** ship a `--mock` data-source mode in the dune sensor so Path B + schema/orchestration tests run before the live fix lands.

**DD-3 — Forecast-before-settle is enforced (FR-4, blocker C2).** `settle.ts` refuses to score a bet with no prior `tetlock-forecast` row (`probability_ppm` pinned before data). The Brier numerator is that `p`; the deterministic verdict is the 0/1 it scores against.

**DD-4 — Forward-rolling window (FR-3, blocker C1).** `resettle-queue.ts` computes a fresh `[discovery_date .. now]` window per re-settle, reusing the pinned thresholds + the versioned query template (NFR-7), never the original window.

**DD-5 — Bet provenance (NFR-7).** Every settle record stores `query_id, sql_template_hash, params, thresholds, verdict_module_sha, data_window`. A later template/threshold change cannot silently rewrite history; calibration is auditable.

**DD-6 — Censored outcomes are first-class (NFR-6).** A cap-abort / budget-refuse writes a typed `censored` settle (not a silent drop). `calibration.ts` reports corpus quality including censored rate — guards survivorship bias.

**DD-7 — Verdict dimensions + INDETERMINATE discipline (FR-5).** `realness-verdict` already returns HELD/FALSIFIED/INSUFFICIENT/INDETERMINATE. Transport/exec failures map to a retry, never to a scored verdict (they would poison the Brier).

---

## 4. Data models

**Settle / bet record** (extends `ResearchSpineEvent`; one append per settle):
```ts
interface CorpusSettle {
  kind: "settle"; tier: "settled";
  candidate_id: string;            // FK → intake
  forecast_id: string;             // FK → tetlock-forecast (REQUIRED, DD-3)
  verdict: RealnessVerdict;        // HELD[real] | FALSIFIED→theater | INSUFFICIENT | INDETERMINATE | censored
  metrics: RealnessMetrics;        // from realness-verdict
  brier_ppm: number | null;        // null until forecast resolved
  resettle_of: string | null;      // FK → original settle (survival re-settles)
  survival: "survived" | "decayed" | "indeterminate" | null;
  // NFR-7 provenance
  provenance: {
    query_id: string; sql_template_hash: string; params: Record<string, unknown>;
    thresholds: RealnessBars; verdict_module_sha: string; data_window: [string, string];
  };
  cost_atom_ref: string;           // metered (Contract A)
  ts: number; prev_hash: string;
}
```

**Candidate intake row** (`src/corpus/intake.ts`, SQLite via `src/cron/store.ts`):
```ts
interface Candidate {
  id: string; question: string; source: string;   // firehose | operator | re-settle
  status: "queued" | "settled" | "rejected" | "censored";
  rejection_reason: string | null;                 // FR-6 selection-bias guard
  created_ts: number;
}
```

**Calibration summary** (`calibration.ts` read): `{ n_settled, n_candidates, funnel_rate, hit_rate, mean_brier_ppm, survival_curve: {t7,t30,t90}, censored_rate }`.

---

## 5. Interfaces (V1 surface)

```ts
// engine.ts
registerCorpusJobs(cron: JobRegistry): void            // wires Path A + Path B schedules
// intake.ts
enqueueCandidate(c: Omit<Candidate,"id"|"status"|"created_ts">): Candidate
rejectCandidate(id: string, reason: string): void
// settle.ts  (Path B core; Path A calls the same after its agentic steps)
settle(candidateId: string, opts: { window: [string,string]; cap_credits: number; mock?: boolean }): Promise<CorpusSettle>
// resettle-queue.ts
scheduleResettles(settle: CorpusSettle): void          // t+7/+30/+90, forward-rolling
dueResettles(now: number): CorpusSettle[]
// budget.ts
checkBudget(cap: number): { ok: boolean; remaining_24h: number } // NFR-6, pre-dispatch
// calibration.ts
readTrackRecord(): CalibrationSummary
```

---

## 6. Security & operations (NFR-5, FR-1)

- **Sandbox isolation:** reuse `src/cron/sandbox-policies.ts` (restricted bash/network, execFile-only, resource caps). Railway Sandbox per Path-A run; Finn-native fallback behind a flag (PRD R1). Candidate questions are schema-validated before reaching any shell (injection guard); secrets scoped per-run, log redaction.
- **Provisioning resilience:** backoff-and-retry on sandbox create; global concurrent-sandbox bound (Gemini #8).
- **Idempotency:** `src/cron/idempotency.ts` keys on `(candidate_id, window)` so a transport death mid-cycle never double-settles (NFR-4); commit-per-settle.
- **Budget:** per-run `--cap` (NFR-3) AND global 24h budget (NFR-6) checked in `budget.ts` before dispatch.

---

## 7. Build phasing (traces PRD §6, flatline #10)

| Phase | Deliverable | Path | Gate |
|---|---|---|---|
| a | dune-meter fix + `--mock`; ONE deterministic replay of SETTLE-003 via `settle.ts` | B | replay reproduces HELD[real] |
| b | scheduled fresh settle (operator-seeded candidate) + forecast registration | A(thin)+B | a settle lands on spine with forecast_id + provenance |
| c | forward-rolling re-settle queue (t+7/+30/+90) | B | a re-settle produces survival label, fresh window |
| d | calibration read + global budget + ≥10-case discrimination benchmark (FR-7) | — | benchmark green; track-record read works |

---

## 8. Traceability

PRD FR-1→§2 scheduler · FR-2→DD-2 · FR-3→DD-4/resettle-queue · FR-4→DD-3 · FR-5→DD-7 · FR-6→intake.ts · FR-7→phase d benchmark · NFR-3→budget.ts · NFR-4→§6 idempotency · NFR-5→§6 · NFR-6→budget.ts/censored · NFR-7→DD-5/provenance.
Flatline: C1→DD-4 · C2→DD-3 · C3→phase d · C4→NFR-6/budget · H1→intake funnel · H2→DD-5 · H3→censored · H4→DD-2 mock · H5→DD-7.

---

## 9. Out of scope (V1)

grok/WEBB autonomous intake (fast-follow; `SIGINT-WIRING.md`) · sellable gadget packaging (#002/#003) · track-record UI/dashboard. The `src/cron` Railway Sandbox adapter stays behind a flag with the Finn-native fallback until Railway Sandboxes exit experimental.

---

## 10. Flatline SDD hardening (Rev 2 — authoritative overrides)

These override the earlier sections where they conflict. Source: `a2a/flatline/sdd-corpus-engine-consensus.md`.

**DD-4′ (BLOCKER S-B1) — idempotency by horizon ordinal, not window.** The idempotency key is `(candidate_id, horizon)` with `horizon ∈ {t0, t7, t30, t90}` — a deterministic ordinal, NEVER the dynamic `[start..now]` window (which changes every run and silently bypasses the lock → double-billing). The forward-rolling window (DD-4) is still what the query USES; it is just not part of the key.

**DD-3′ (BLOCKER S-B2) — per-horizon forecasts; survival ≠ discovery.** Brier may not score a t0 discovery forecast against t+N survival data — they are different events. Each horizon registers its OWN forecast (`p_survival_7d`, `p_survival_30d`, `p_survival_90d`) before its re-settle, and that re-settle scores against ITS forecast. A re-settle with no registered horizon forecast is a **ground-truth observation** (records survival, no Brier) — never mis-scored against the discovery `p`.

**DD-8 (S-H1) — sandbox→host SettleIntent envelope.** The Path-A Railway Sandbox has ZERO spine write access. It emits a typed, schema-validated `SettleIntent` (stdout or a scoped bucket); the HOST `settle.ts` reads, validates, meters, and is the sole committer to the spine. Prevents ledger poisoning / silent drops across the trust boundary.

**DD-9 (S-H2) — reserveBudget, not checkBudget (TOCTOU).** `budget.ts` exposes a transactional `reserveBudget(cap)` (SQLite tx / lock) taken BEFORE dispatch; actual atom cost settles/refunds the reservation; one unique cost-ledger entry per run. Replaces the racy preflight-only `checkBudget` (§5).

**DD-10 (S-H3/S-H4) — dune-meter pinned + serialized.** Pin the dune-meter version; golden contract tests on its JSON; strict output-schema validation; an explicit failure taxonomy (retryable vs terminal — a 429 is retryable-with-backoff, a budget-refuse is terminal→censored). Store the FULL resolved SQL text (blob, referenced by `sql_template_hash`) so a re-settle can reconstruct the exact historical query even if the template file mutates. All Dune calls go through ONE global rate-limited queue (max 1 concurrent) — no thundering herd on a cron tick.

**DD-11 (S-H5) — append-only lifecycle + durable re-settle jobs.** `Candidate` carries only coarse intake state; settle / resettle / censor / reject are append-only events, status is DERIVED. Re-settles live in a durable `CorpusResettleJob` table: `{candidate_id, horizon, due_ts, attempts, status, lease_owner, forecast_id, original_settle_id}`. `scheduleResettles()` idempotently upserts the t7/t30/t90 rows; `dueResettles()` reads from this table (not an in-memory array).

**§6′ (S-H6) — candidate input is hostile end-to-end.** Beyond schema validation: length caps, allowlisted fields, PARAMETERIZED SQL only (no string interpolation into queries), no shell interpolation of candidate text, prompt-injection containment before any Path-A composition, log escaping/redaction, deny-by-default network egress in the Path-A sandbox, and source authentication + per-source quota in `enqueueCandidate` (a firehose cannot flood the global budget).

**Brier state machine (MED).** Only binary scored outcomes enter the Brier denominator; INSUFFICIENT / INDETERMINATE / censored are excluded from Brier but counted in censor-rate + funnel metrics. A `censored` re-settle at t+N schedules a delayed retry after the 24h budget resets — it does not terminate the candidate's re-settle chain.

