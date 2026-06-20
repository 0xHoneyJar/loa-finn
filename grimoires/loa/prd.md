# PRD: The Corpus Engine — automating the realness loop

**Status:** Draft
**Author:** Finn (main-loop) + operator
**Date:** 2026-06-14
**Cycle:** cycle-053
**Supersedes (in the active slot):** `prd.archived-2026-06-14-pre-corpus-engine.md` (the March-26 Per-NFT Personality PRD, unrelated — preserved, not deleted)

> **Hivemind:** artifact_type: product-spec · workstream: experimentation · priority: high
> **One line:** turn the hand-run realness loop into a scheduled, governed, cost-capped engine that grows a calibration track record — the franchise no competitor can copy in a weekend.
> **Rev 2 (2026-06-14):** flatline-reviewed (headless GPT-5.5 + Gemini-3.1-pro; opus dropped). Two BLOCKERS fixed (FR-3 forward-rolling window, FR-4 forecast registration) + 5 findings integrated. See `a2a/flatline/prd-corpus-engine-consensus.md`.

---

## 0. Why this, why now (grounded)

The realness filter is **validated as an instrument**: it returns THEATER for x402 (99.3% self-dealing, shrinking) and REAL for Kintara $KINS (29,009 traders, top-1 5.78%, growing) — `grimoires/loa/lab/SETTLES.md` (SETTLE-001/002/003). But all three runs were **hand-run** (the main loop acting as each desk). A standing research lab cannot be hand-run — that's the "consumption-gradient slip" (hand-running *feels* lighter, defects from the governed runtime). The engine is what forces the discipline a one-off appraisal can skip.

The strategic payload (`grimoires/loa/context/gadget-factory-brief.md`): *don't sell the loupe — sell the appraiser's reputation.* A realness score is a commodity; the **calibration track record** (pre-registered, deterministically-settled, Brier-scored bets) is the only thing in the stack that compounds. The corpus engine is the machine that grows it.

---

## 1. Problem Statement

The lab can produce a metered, grounded, deterministically-settled realness verdict — but only when a human drives every step, on demand. There is no standing process that (a) sources new candidates, (b) runs the full loop on a schedule without a human at each seam, (c) re-settles prior verdicts over time to test *survival* (not just present-tense realness), or (d) accumulates the results into a scored, queryable track record.

> Source: `gadget-factory-brief.md:33-46` (the pushback + the automation design); `NOTEBOOK.md` entry 002 ("WEBB's firehose is manual today… the Grok SIGINT sensor is the wire that makes her desk autonomous — that's the next build, not the next probe").

**`realness ≠ survival`** is not a caveat — it is the product spec for the loop's second pass. A one-shot settle measures the present; survival needs the *same bet re-settled over time* (SETTLE-003 caveat: "a pump.fun token growing 6× in 3 weeks can be a real, distributed speculative mania and still round-trip to zero").

---

## 2. Goals & Success Metrics

| Goal | Metric | Source |
|---|---|---|
| Grow a calibration track record | N settled bets on the spine with registered forecast + Brier score, accumulating weekly | `experiment-economics.md:92-101` (learning_yield = Σ tier-weighted settled beliefs / cost) |
| Test survival, not just realness | Each REAL verdict re-settled at t+7/+30/+90; survival labeled per bet | SETTLE-003 caveats; operator (2026-06-14) |
| Run governed, not hand-run | 0 hand-run settles post-V1; every run via the cron→`lab-cycle` path with a `valid_run` | `COMPOSITION.md`; CLAUDE.md consumption-gradient doctrine |
| Stay cheap | Per-run Dune credits hard-capped; learning_yield trends up | `experiment-economics.md:112-140`; Dune quota 2500/mo (verified `getUsage`) |

**V1 success definition:** the engine runs `lab-cycle` on a schedule in a Railway Sandbox, settles ≥1 fresh candidate AND re-settles ≥1 prior REAL verdict per cycle, appends both to the spine with Brier scores, and never exceeds its per-run credit cap — unattended, for ≥2 consecutive scheduled cycles.

**Explicit non-goal (V1):** external revenue / packaging sellable gadgets (#002 survival-forecaster svc, #003 realness-score svc). Internal edge — the track record steering what THJ builds — first. (Operator, 2026-06-14.)

---

## 3. Users & Stakeholders

| Persona | Job-to-be-done | Priority |
|---|---|---|
| **Operator / THJ (internal)** | "Tell me what's actually real in the trenches so I build for real demand, not theater" — steers TBA/Mint/Freeside bets | **Primary (V1)** |
| **The lab itself (Finn)** | consumes its own track record to calibrate forecasts (TETLOCK) and source candidates (WEBB) | Primary |
| **External consumers (future)** | a realness API / survival-forecaster / daily readout | Deferred (post-V1) |

> Source: `gadget-factory-brief.md` fork #3 resolved → "internal edge first" (operator, 2026-06-14).

---

## 4. Functional Requirements

**FR-1 — Scheduled loop dispatch.** The system shall run the `lab-cycle` composition on a schedule via the existing `src/cron` JobRunner, dispatching into a Railway Sandbox per run.
- AC: a schedule entry triggers a `lab-cycle` run; the run executes PROBE→REGISTER→DESIGN→⟦pin-bars⟧→SETTLE→CALIBRATE; a `valid_run` proof is recorded.
- Grounding: `src/cron/{runner,schedule,job-registry,service}.ts` exist (verified 2026-06-14); `railway-sandbox-spike-memo.md:28-32`.

**FR-2 — Governed deterministic settle (headless).** When a settle runs in a headless cron, the system shall query Dune via the governed `dune-meter` path (key-based, cost-capped, execute-by-id), NOT the Dune MCP.
- AC: a headless run completes a settle with no interactive MCP; the run carries a cost atom with the credits consumed.
- Grounding: the Dune MCP is interactively authenticated (absent in headless runs — harness note); `dune-meter` is currently broken (HTTP 405 on execute) — `SETTLES.md` SETTLE-001 provenance. **This is blocking dependency #1.**

**FR-3 — Survival re-settle (forward-rolling window).** The system shall, on schedule, re-measure each prior `HELD[real]` verdict at t+7/t+30/t+90 using the SAME pinned thresholds + SAME query template but a FRESH, forward-rolling data window (the days since discovery), producing a survival-labeled datapoint and a Brier update.
- **Flatline C1 (BLOCKER, both voices) fix:** re-settle must NOT replay the original window — that is static by construction and measures nothing. It advances the data window to observe actual post-discovery decay/survival. Same thresholds, new data.
- AC: a REAL verdict ages into a re-settle queue; the re-run queries fresh data for the post-discovery window and yields {survived | decayed | indeterminate} + a calibration update; both the original snapshot and the new window are stored.
- Grounding: SETTLE-003 open thread (NOTEBOOK 002); operator priority (2026-06-14); flatline consensus C1 (`a2a/flatline/prd-corpus-engine-consensus.md`).

**FR-4 — Forecast registration + calibration ledger (the franchise).** Before each settle, the system shall register a probabilistic forecast (`probability_ppm` + `base_rate_ppm` + `resolution_criterion`, via `tetlock-forecast.ts`), pinned BEFORE any data is read; after the deterministic settle it shall Brier-score that forecast against the outcome and append the scored bet to the spine; a ledger-read exposes the track record (count, hit-rate, mean Brier, survival curve).
- **Flatline C2 (BLOCKER, both voices) fix:** the Brier numerator is the PRE-REGISTERED probability (PLATT pins bars, TETLOCK registers `p`); the deterministic verdict is the 0/1 it scores against, not the forecast. The mechanism already exists (`tetlock-forecast.ts`); V1 makes it a REQUIRED, enforced step — no settle without a prior registered forecast.
- AC: a settle with no prior registered forecast is rejected; `verifySpineChain()` passes after append; ledger-read returns the running calibration summary.
- Grounding: `tetlock-forecast.ts` (`probability_ppm`/`resolution_criterion`); `spine-ledger.ts`; `experiment-economics.md:92-101`; flatline C2.

**FR-5 — Verdict via GADGET #001.** The deterministic SETTLE verdict shall be computed by the `realness-verdict` module (pure, tested), not ad-hoc per run.
- AC: the engine imports `gadgets/realness-verdict` (graduated to `src/` under /implement); its discrimination test stays green (Kintara→REAL, x402→THEATER).
- **Flatline H5/MED fix:** the verdict carries boundary dimensions (present distribution · organic-demand proxy · manipulation/sybil risk · survival), and `INDETERMINATE` is reserved for the honest bar-gap ONLY — transport/exec failures are `INSUFFICIENT`/retry, never a scored verdict (else they poison the Brier).
- Grounding: `grimoires/loa/lab/gadgets/realness-verdict/` (built + 5/5 this session).

**FR-7 — Discrimination benchmark before autonomy.** Before GADGET #001 is wired into the autonomous scheduled engine, its thresholds shall be validated against a benchmark suite of ≥10 diverse, independently-known REAL/THEATER cases (backtest/holdout), with false-REAL/false-THEATER rates recorded and thresholds locked.
- **Flatline C3 (HIGH, both voices) fix:** a 2-case validation (SETTLE-001/003) is a seed, not proof; sybil/bot volume can spoof basic organic metrics. Autonomous wiring is GATED on the benchmark.
- AC: the suite exists, runs green, results stored; autonomy gated on it.
- Grounding: flatline C3.

**FR-6 — Candidate intake (manual V1, autonomous fast-follow).** The system shall accept a candidate via a TRANSACTIONAL store (a state table, not a flat file — race/double-settle safe), ledger EVERY candidate with source + inclusion/rejection reason, and report calibration over the FULL intake funnel (not only settled bets).
- **Flatline H1 (HIGH) + Gemini #6 fix:** manual intake is a selection-bias hole — a cherry-picked corpus is a fake track record. Logging every candidate + rejection reason + funnel-level calibration is the guard; a transactional store (not a flat queue file) removes the race/double-settle risk.
- AC (V1): a candidate row triggers a scheduled loop; rejections recorded with reasons; funnel calibration queryable.
- Grounding: `src/cron/store.ts` (transactional store exists); `SIGINT-WIRING.md` (grok autonomous = fast-follow); flatline H1 + Gemini #6.

---

## 5. Technical & Non-Functional Requirements

**NFR-1 — Deterministic settle only.** If a settle verdict is produced, it shall come from a deterministic instrument (on-chain / test / market P&L), never an LLM. (`epistemology-deterministic-layers.md` §4.)

**NFR-2 — Metered, every step.** The system shall close a hash-chained cost atom before any finding/settle is representable (`cost-atom-research.ts`, Contract A). A run without atoms didn't happen.

**NFR-3 — Hard per-run credit cap.** The sandbox shall enforce a hard Dune credit cap per run; on cap, the run aborts with a typed failure, no partial settle. (The dropped-call double-charge in SETTLE-003 is the motivating incident; `dune-meter --cap` is the mechanism.)

**NFR-4 — Orchestration reliability over clever science.** The engine shall use commit-per-item and idempotent re-settle so a transport death mid-cycle is recoverable without double-settle.
- Grounding: "the cheap deterministic floor held; the expensive part was the orchestration wrapper" (`experiment-economics.md:138-140`); existing `src/cron/{idempotency,circuit-breaker,kill-switch}.ts`.

**NFR-5 — Sandbox isolation.** Runs execute under restricted bash/network, execFile-only, with resource caps (max tool-calls / runtime / items). (`src/cron/sandbox-policies.ts`; `railway-sandbox-spike-memo.md:28-32`.)

**NFR-6 — Global rolling credit budget + censored-outcome accounting.** Beyond the per-run cap (NFR-3), the JobRunner shall enforce a global rolling (e.g., 24h) Dune-credit budget before dispatching any run; a cap-abort shall be recorded as a typed `censored` outcome counted in corpus-quality metrics, never silently dropped.
- **Flatline C4 (HIGH, both) + GPT-5.5 #7 fix:** fresh candidates + an accumulating t+7/+30/+90 re-settle backlog will exhaust the 2,500/mo quota without a global cap; silently dropping cap-aborts is survivorship bias.
- Grounding: `experiment-economics.md` (2,500/mo ceiling); `src/cron/rate-limiter.ts`.

**NFR-7 — Bet provenance / versioning.** Each settle shall store, as part of the bet: the Dune query ID, the SQL/template version hash, parameters, pinned thresholds, the verdict-module commit SHA, and the exact data window. A later query/threshold change MUST NOT silently rewrite the meaning of historical calibration.
- **Flatline H2 (GPT-5.5 #6) fix:** unversioned templates make the track record un-auditable. Grounding: the spine's append-only hash-chain (`spine-ledger.ts`).

**Compute substrate (decided):** **Railway Sandbox** — verified available 2026-06-14 (`railway sandbox list` returns clean; the spike memo's `PROJECT_SANDBOXES` flag blocker is CLEARED). Still flagged EXPERIMENTAL by Railway → keep the Finn-native `src/cron` path as the fallback behind a flag (spike memo's standing recommendation, `:43-52`).

---

## 6. Scope & Prioritization

### V1 (this cycle) — "Loop + survival re-settle" (operator-confirmed)
1. Fix `dune-meter` governed headless Dune path (blocking dep #1; cross-repo loa-freeside).
2. Graduate GADGET #001 `realness-verdict` into `src/` (under /implement).
3. Wire `src/cron` JobRunner → `lab-cycle` dispatch into a Railway Sandbox, scheduled.
4. Survival re-settle queue (t+7/+30/+90) for REAL verdicts.
5. Calibration-ledger append + read (spine) — with forecast registration (FR-4) + bet provenance (NFR-7).
6. Candidate intake = operator-seeded via a transactional store (FR-6).

**V1 build phasing (Flatline #10 — de-risk sequencing):** (a) dune-meter fix + ONE deterministic replay of an existing settle → (b) scheduled fresh settle (with forecast registration) → (c) survival re-settle queue (forward-rolling window) → (d) calibration readout + the discrimination benchmark (FR-7). Each phase lands before the next opens.

### Fast-follow (next cycle)
- WEBB autonomous: wire the grok SIGINT firehose (needs a Cheval xai provider — `SIGINT-WIRING.md`).
- The survival-forecaster gadget (#002) once the corpus has enough re-settle datapoints.

### Out of scope (V1)
- External revenue / packaged sellable gadgets (#002/#003 as products).
- A UI/dashboard for the track record (a ledger-read is enough for V1).

---

## 7. Risks & Dependencies

| # | Risk / Dependency | Severity | Mitigation |
|---|---|---|---|
| D1 | `dune-meter` broken (HTTP 405 execute; cross-repo loa-freeside) | **Blocking** | Fix it first (execute-by-id, executable bin, saved query) — `SETTLES.md` SETTLE-001 provenance. **+ Flatline H4:** the 405 may be a Dune tier/endpoint restriction, not a routing bug → build a mocked data-source fallback so orchestration + schema testing aren't blocked on the live fix |
| R1 | Railway Sandbox is EXPERIMENTAL (API may change) | Medium | Keep Finn-native `src/cron` fallback behind a flag (spike memo) |
| R2 | Headless cron lacks the Dune MCP | Medium | D1 (dune-meter) is the resolution; do not depend on the MCP in cron |
| R3 | Orchestration-wrapper fragility (transport deaths mid-cycle) | Medium | commit-per-item + idempotent re-settle (NFR-4); proven failure mode (`experiment-economics.md:117-119,138-140`) |
| R4 | Cost runaway (unbounded Dune scans) | Medium | Hard per-run `--cap` (NFR-3); the SETTLE-003 double-charge is the warning |
| R5 | `src/research`/`src/cron` graduation touches App Zone | Low | Goes through /implement gates (not micro-fix) |
| R6 | grok SIGINT needs a framework-side Cheval xai provider | Low (deferred) | Out of V1; specced in `SIGINT-WIRING.md` |

---

## 8. Verified facts (this session — ground truth)

- `src/cron/` exists with runner, schedule, idempotency, circuit-breaker, kill-switch, rate-limiter, concurrency, sandbox-policies (+ dry-run, job-registry, service, store, types). **Verified `ls` 2026-06-14.**
- Railway Sandbox available now (`railway sandbox list` clean; flag cleared since the 2026-06-06 spike). **Verified 2026-06-14.**
- Realness filter validated (SETTLE-001/002 theater; SETTLE-003 real). GADGET #001 built + 5/5 tests.
- Dune quota: 2500 credits/mo; ~16 used this session. `dune-meter` still broken.

> **Sources:** `gadget-factory-brief.md`, `grimoires/loa/lab/{SETTLES,NOTEBOOK,COMPOSITION,SIGINT-WIRING,METHODOLOGY}.md`, `grimoires/loa/lab/roster/*.md`, `context/railway-sandbox-spike-memo.md`, `context/experiment-economics.md`, `context/epistemology-deterministic-layers.md`, live verification (`ls src/cron`, `railway sandbox list`, Dune `getUsage`), and the pre-generation gate (operator answers, 2026-06-14).
