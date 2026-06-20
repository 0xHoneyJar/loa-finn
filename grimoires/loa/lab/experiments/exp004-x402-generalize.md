---
status: candidate
created: 2026-06-13
cycle: cycle-053
spine_premise: EXP-004
settle_candidate: SETTLE-002
composition_run_id: labcycle-exp005-171851
note: "DESIGN ONLY — bars pinned by operator BEFORE any Dune settle runs (anti-p-hacking seam). No data measured in this segment."
---

# EXP-004 · Does x402 self-dealing GENERALIZE, and is genuine volume GROWING?

The lab loop, each desk in turn, scoping the EXP-004 PREMISE
("on-chain theater-vs-buyer-diverse, re-confirms EXP-002") into a single
worth-settling belief and a pre-registered deterministic falsification bar.
**The Dune settle is NOT run here.** PLATT's bars are pinned by the operator first.

---

## JOBS — the Product/Ship Desk: scope to the thinnest worth-settling belief

**The boil-the-ocean version (KILLED):** "Measure self-dealing across every x402
facilitator (x402x, Coinbase CDP, PayAI, …), every token, a 90-day window, with a
genuine-vs-wash trend per facilitator." Four problems, each fatal to a thinnest path:

1. **The cross-facilitator table does not exist as one schema.** Grounded against the
   Dune catalog (`searchTables`, base, 2026-06-13): the only decoded table on Base
   exposing a clean `payer → payTo` settlement pair is
   `x402x_base.settlementrouter_evt_settled` (page_rank 2.39, the SETTLE-001 table).
   The other Base settlement contracts — `commerce_payments_protocol` (Coinbase's
   rails), `freysa_base.payment`, `immersve_base.fundsmanagerlogic_evt_settlement`,
   `inflynce_hub_base.hub_payments` — have **heterogeneous schemas with no uniform
   payer/payTo pair**. "Across all facilitators" would require N bespoke per-protocol
   self-dealing definitions = N experiments, not one. That is creeping elegance: an
   elegant cross-protocol abstraction the territory does not support.
2. **A per-facilitator trend AND a cross-facilitator concentration in one settle**
   conflates two beliefs. Two beliefs = two falsifiable bars = a muddy verdict.
3. **SETTLE-001 already settled "x402x is ~99% self-dealing over 30 days."** Re-running
   the *same* facilitator's *same* metric is confirmation theater, not a new bet.
4. **Cost.** SETTLE-001 cost 0.075 credits on `small` for one 30-day scan. A
   90-day × multi-table sweep multiplies the partition scan; the cost gate
   (`MAX_MICRO_USD_PER_PROBE`) exists precisely to refuse this.

**The cut (the one belief worth settling):** the EXP-004 open thread (NOTEBOOK entry
001, last line) is *"is the ~0.7% real fraction growing?"* — the **TREND**, not the
breadth. The decision it changes: **does the realness-filter wedge get more or less
valuable over time?** If genuine x402x volume is *growing*, the wedge is timely and
the lab should keep instrumenting it; if *flat/declining*, x402x agentic commerce is
theater all the way down and the wedge's value is in *exposing* it, not riding it.

> **THE THINNEST WORTH-SETTLING BELIEF (scoped):**
> *"On x402x SettlementRouter (Base, USDC), genuine non-self-dealing volume is FLAT or
> DECLINING across the ~90-day window — the self-dealing share is not falling."*
> One table. One token. One metric (genuine $/period). One deterministic query.
> The breadth question ("does it generalize to other facilitators") is **deferred to a
> V2 experiment** once a uniform cross-facilitator view is built — named, not built.

**What is cut and why:** cross-facilitator breadth (no uniform schema — V2);
multi-token (USDC is 95%+ of x402 volume per the OSINT claim — adding tokens is
elegance, not signal); the concentration re-measurement (SETTLE-001 already has it).

---

## STAMETS / PROBE — grounded, cited, metered probe of the CLAIMED landscape

**Cost surfaced BEFORE finding (METHODOLOGY §1, atom-first):** this is a *read of the
already-landed PROBE-001 claimed event on the spine* + the existing OSINT citation set
(`spine-events.jsonl`, cost_atom_ref `01KV1G2R4RF460K0566QXE2TW7`, 41 citations,
gemini, grounded:true). **No new probe spend** — reusing a closed atom. New-probe cost
estimate if re-run: 0 micro-USD (Gemini dig-search is subscription, `cost_micro: 0n`).

**What the claimed landscape says (tagged `claimed-by-sensor: gemini-osint`,
confidence: medium):**
- Artemis/Allium: **81% of x402 volume is wash-trading**; headline $24M/mo → $1.6M
  genuine. `[claimed]`
- A **maturation signal**: *"transactions of $1 or more now represent 95% of total
  volume,"* up from sub-cent heartbeat spam — i.e. the genuine fraction is claimed to
  be *rising* as PING-memecoin flooding washes out. `[claimed — directly bears on the
  trend bar; this is the inside-view "it's getting real" story]`
- Coinbase CDP **subsidizes** the rails (fee-free gasless USDC via EIP-3009), which
  *obscures* unit economics — growth may be subsidy-driven, not demand-driven
  (corroborates the EXP-002 "subsidy was the demand" finding in auto-memory). `[claimed]`

**Abstention boundary:** the OSINT set says nothing citable about **x402x-specific**
genuine-volume trend over 90 days (it speaks of x402 *ecosystem-wide*). The
facilitator-specific trend is **uncitable from OSINT** — which is exactly why it must
be SETTLED on-chain, not asserted. PROBE abstains on the x402x-specific trend and hands
it to the deterministic instrument. (This is the map ≠ territory law: the press release
talks ecosystem; the chain talks this contract.)

---

## TETLOCK — register the forecast (outside view first, then calibrated p, then draft bar)

**Outside view / base rate (established FIRST):**
- Reference class: *early-stage crypto "agentic/AI" volume metrics that a third-party
  analytics firm has flagged as majority-wash.* Base rate that the genuine fraction is
  *growing* rather than flat/declining in the 1–3 months *after* such a flag: **LOW.**
  Washed-out memecoin-farming cohorts (PING) collapse fast; the residual is small and
  noisy. EXP-002 (auto-memory: 39,999 registered → 0 funded; "subsidy was the demand")
  is a same-reference-class prior pointing the same way: when the subsidy/farming
  mechanism is the demand, genuine volume does **not** organically grow once flagged.
- Counter-signal (inside view, resist over-weighting): the OSINT "$1+ txns now 95%"
  maturation claim is a genuine-growth story. But it is (a) ecosystem-wide not
  x402x-specific, (b) a *composition* shift (spam washing out) that can *raise the
  fraction while absolute genuine $ stays flat* — a fraction-vs-absolute trap the bar
  must avoid.

**The forecast (the BET — registered before the settle):**
> **Belief[theater-persists]:** "Genuine non-self-dealing x402x volume is FLAT or
> DECLINING across the ~90-day window."
> - `base_rate_ppm`: **700000** (≈70% — outside-view prior that genuine volume does
>   NOT grow post-flag in this reference class).
> - `probability_ppm` (calibrated, after the $1+ maturation counter-signal nudges it
>   down slightly): **650000** (≈65% the theater-persists belief HOLDS).
> - This is a *deliberately killable* forecast: a clear genuine-growth trend
>   FALSIFIES it. TETLOCK wants the score, not to be right.

**Draft numeric resolution criterion (TETLOCK carries it; PLATT pins it below):**
the belief resolves on ONE primary statistic — the normalized OLS slope `β` of weekly
`genuine_usd`: HOLDS iff `β ≤ +0.05/week` (flat/declining within noise); FALSIFIED iff
`β ≥ +0.10/week` (sustained rise); INSUFFICIENT iff `β` is in the indeterminate band
`(+0.05, +0.10)` with split corroborants, or too few non-self-dealing weeks to fit `β`.
(Single statistic → single `outcome` → single Brier; PLATT's bar below is canonical.)

---

## PLATT — the CRUCIAL experiment + PRE-REGISTERED BARS (deterministic, never an LLM)

**The crucial experiment (one deterministic Dune query — designed to FALSIFY, not
confirm):**

- **Table:** `x402x_base.settlementrouter_evt_settled` (GROUNDED: exists, page_rank
  2.39, fields confirmed via `searchTables` 2026-06-13 — `payer`, `payTo`, `amount`
  uint256, `token` varbinary, `evt_block_date` date, `facilitatorFee`).
- **Token filter:** USDC `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` (6dp →
  `amount / 1e6` = USD).
- **Window:** trailing **~90 days**, bucketed by **`evt_block_date` truncated to ISO
  week** (partition-filter on `evt_block_date` to bound `small`-tier cost, per
  SETTLE-001 governance note).
- **Genuine definition (deterministic, conservative — same as SETTLE-001):** a
  settlement is *genuine* iff `payer != payTo` (self-dealing floor). `genuine_usd[week]
  = Σ amount/1e6 WHERE payer != payTo`, grouped by week.
- **The trend statistic:** ordinary-least-squares slope of `genuine_usd` vs. week index
  across the full window (sign + magnitude). Report alongside: total genuine $, genuine
  share of total $ per week, distinct genuine payers per week (the buyer-DIVERSITY
  axis — a rising count of distinct non-self payers is the real-demand tell).
- **Why this kills:** if x402x genuine agentic commerce were *arriving*, genuine_usd and
  distinct-genuine-payers rise week over week. If it is theater, they sit at the
  SETTLE-001 floor (~$121/30d ≈ ~$4/week) and the slope is flat/negative. The query
  *cannot* confirm the belief by construction — it can only fail to falsify it.

### PRE-REGISTERED BARS (pin BEFORE the settle — the anti-p-hacking seam)

**The ONE primary statistic (the single thing the verdict resolves on):** the
**OLS slope of weekly `genuine_usd` over the full window**, `β`, expressed as the
fraction of the first-3-week mean it adds per week (slope normalized by the
first-3-week mean, so the bar is scale-free). One statistic → one deterministic
`outcome` → one clean Brier score. The `TetlockForecast` schema carries a single
`outcome` field and a single `brier_ppm` (`tetlock-forecast.ts` L47–48), so the
bar MUST resolve to exactly one of {held, falsified, insufficient}. The
distinct-genuine-payers-per-week trend and the first-3wk→last-3wk genuine_usd
ratio are **secondary corroborants** — reported alongside, used only to break the
narrow `|β|` indeterminate band, never as co-equal triggers that could disagree
with the primary and muddy the verdict.

> **Why OLS slope is primary, not the 2× endpoint ratio (the prior-stage finding,
> resolved here):** on a noisy ~13-week series an endpoint-mean ratio can fire on a
> single-week spike while the underlying trend is flat — and the OLS slope and the
> ratio CAN DISAGREE (a 2× jump with a negative slope, or a positive slope without
> a 2× ratio). Two co-equal disjuncts → two possible outcomes → an ambiguous Brier.
> The OLS slope is robust to a single-week endpoint spike (every week is a leverage
> point on the fit, not just the last three), so it is the one that kills cleanly.

| Verdict | Condition (deterministic, checked against the query output) — resolves on `β` ONLY |
|---|---|
| **HELD[theater-persists]** | Normalized OLS slope `β ≤ +0.05/week` (genuine volume adds **≤ 5%** of its starting level per week — flat or declining within noise). The self-dealing share stays ≥ ~95%. *(Corroboration expected, not required: distinct-genuine-payers slope ≤ 0.)* |
| **FALSIFIED[real/arriving]** | Normalized OLS slope `β ≥ +0.10/week` (genuine volume adds **≥ 10%** of its starting level per week — a sustained rise, ≈ +>2× over a 13-week window from trend alone). Buyer-diversity is then a corroborant, not a trigger. |
| **INSUFFICIENT** | `+0.05 < β < +0.10/week` (the indeterminate band — too weak to call either way) **and** the two corroborants split (distinct-genuine-payers slope and the first-3wk→last-3wk genuine_usd ratio point in opposite directions); OR fewer than ~5 weeks have any `payer != payTo` settlements (too few points for a credible OLS fit); OR the table is empty/unavailable for the window; OR the Dune `small`-tier scan refuses/cap-aborts. No verdict; abstain. |

**Tie-break rule (deterministic, pinned now):** if `β` lands in the indeterminate
band `(+0.05, +0.10)` AND the two corroborants AGREE in direction, the verdict
follows the corroborants' shared sign (both-up → FALSIFIED; both-flat/down → HELD).
If they split, it is INSUFFICIENT. This makes every possible numeric outcome map to
exactly one verdict with no overlap — the bars partition the real line, leaving no
gap a post-hoc reading could exploit.

**Provenance/governance note (carried from SETTLE-001):** the settle should route the
governed `dune-meter --cap` path once fixed; until then the **Dune MCP `small` tier with
a partition-filter on `evt_block_date`** is the bounded fallback (SETTLE-001 cost 0.075
cr for a 30-day single-table scan; a 90-day weekly bucket on one table is the same order).

---

## STOP — operator pins the bars

Per the anti-p-hacking seam: **the operator pins the three bars above BEFORE any data is
measured.** No `createAndExecuteQuery` was run in this segment. On pin, the SETTLE step
runs the one deterministic query (`x402x_base.settlementrouter_evt_settled`, USDC `0x8335…2913`
6dp, trailing ~90d, ISO-week buckets, `payer != payTo` genuine floor) and computes the **one
primary statistic — the normalized OLS slope `β` of weekly `genuine_usd`** (with distinct-
genuine-payers/week and the first-3wk→last-3wk ratio as corroborants). TETLOCK then Brier-scores
the `probability_ppm: 650000` forecast against the single HELD/FALSIFIED/INSUFFICIENT outcome
the bars partition — no co-equal disjunct can split the verdict.
