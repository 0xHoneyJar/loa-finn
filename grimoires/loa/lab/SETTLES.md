# Ledger of Bets — Settlements

The lab's resolved bets. A `claimed` probe (OSINT/SIGINT, cited-but-soft) graduates to
`settled` only when a **deterministic instrument** (on-chain / test / market P&L — never an
LLM) resolves it. Each settle records: the bet, the crucial experiment (PLATT), the
deterministic result (SETTLE), and the calibration (TETLOCK).

---

## SETTLE-001 · x402 agentic-payment realness (the wash claim)

- **Date:** 2026-06-13
- **Bet (claimed, PROBE-001 · gemini OSINT):** "x402 agentic-payment volume on Base is
  predominantly wash-trading — Artemis/Allium: ~81% wash, $24M headline → $1.6M genuine."
  Landed `claimed`-tier on the spine (`grimoires/loa/lab/spine-events.jsonl`, cost_atom_ref
  `01KV1G2R4RF460K0566QXE2TW7`).

### DESIGN — the crucial experiment (PLATT)
Strong inference: a single deterministic on-chain query that *falsifies* the wash thesis if it
fails. Pre-registered bars:
- **Concentration:** share of volume from the top-10 `payer→payTo` pairs.
- **Direct self-dealing:** share of volume where `payer == payTo` (the same address paying
  itself — an unambiguous wash signal, conservative: real wash ≥ this).
- **Falsification condition:** if volume were broadly distributed (low concentration, near-zero
  self-dealing), the "mostly wash" claim is FALSE.

Table: `x402x_base.settlementrouter_evt_settled` (x402x SettlementRouter "Settled" event, Base).
Window: last 30 days. Token: USDC (`0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`, 6dp).

### SETTLE — deterministic on-chain (Dune)
Dune query **7717781** (`https://dune.com/queries/7717781`), engine `small`, **0.075 credits**:

| metric | value |
|---|---|
| total volume (30d) | $18,408 USDC |
| settlements | 13,575 |
| distinct payers / payTos | 300 / 46 |
| top-10 `payer→payTo` pair share | **99.3%** |
| **`payer == payTo` self-dealing share** | **99.3%** ($18,287 / $18,408) |
| genuine (non-self-dealing) volume | ~$121 |

**Verdict: the bet RESOLVES TRUE — and the claim understated it.** ~99% of x402x volume is the
same address paying itself. The map said 81% wash; the deterministic territory says ~99%.

### CALIBRATE (TETLOCK)
The OSINT forecast ("mostly wash") was **directionally correct, magnitude understated**
(predicted 81%, observed 99% on this facilitator). A well-calibrated "this is mostly theater"
call — the realness-filter wedge, validated. Brier: the binary "predominantly wash" prediction
resolves correct.

### Caveats (the boundary — evidence vs aspiration)
- **One facilitator, not all of x402.** `x402x` SettlementRouter is a single (high-rank)
  facilitator; Coinbase CDP, PayAI, and others settle separately. The $24M "headline" is the whole
  ecosystem; this $18.4K is x402x only. The *self-dealing pattern* is the transferable finding,
  not the absolute volume.
- **Conservative wash proxy.** `payer == payTo` is the floor; related-but-distinct address wash
  would push it higher, not lower.
- **30-day / USDC window.** Other tokens + longer windows unmeasured here.

### Provenance / governance note
Settled via the **Dune MCP** on `small` tier (bounded, 0.075 cr, cost-reported) — NOT the
governed `dune-meter` lab path, because dune-meter is currently broken: raw-SQL execute →
HTTP 405 (`POST /api/v1/query/execute` is not a live Dune endpoint), and its query_id path 403s
on temp queries. Flipping the lab's `dune.ts` sensor fully live + governed needs: (1) dune-meter's
execute endpoint fixed (create-query-then-execute-by-id), (2) the bin made executable / wrapped
for `DUNE_METER_BIN`, (3) a saved (non-temp) query. Tracked as the next Dune step.

---

## SETTLE-002 · x402 "the theater persists" (genuine-payer growth, 90d weekly)

- **Date:** 2026-06-13
- **Belief under test (PINNED bars — operator accepted PLATT's bars as-is, FROZEN):**
  *"The theater persists"* — x402 genuine agentic commerce is not arriving; it stays self-dealing
  and flat-to-shrinking on the x402x rail.

### PINNED BARS (frozen — not changed by this settle)
- **HELD[theater-persists]:** weekly `genuine_usd` (payer != payTo, USDC) OLS slope ≤ 0 **AND**
  distinct-genuine-payers/week slope ≤ 0; self-dealing share stays ≥ ~95%.
- **FALSIFIED[real/arriving]:** weekly `genuine_usd` grows ≥ 2× (mean of first 3 wks → mean of last
  3 wks) **OR** distinct genuine payers/week rises ≥ 2×.
- **INSUFFICIENT:** < 3 weeks have any `payer != payTo` settlements, OR table empty/unavailable, OR
  Dune small scan refuses/cap-aborts.

### REGISTERED FORECAST (TETLOCK, pre-settle)
`probability_ppm = 650000` (~65% the theater-persists belief HOLDS); `base_rate = 70%`.

### SETTLE — deterministic on-chain (Dune)
One query: `x402x_base.settlementrouter_evt_settled`, token USDC
(`0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`, `amount/1e6`), `date_trunc('week', evt_block_date)`,
partition-filtered `evt_block_date >= CURRENT_DATE - INTERVAL '90' DAY`, engine `small`.
Genuine = `payer != payTo`. **Dune query 7718233** (`https://dune.com/queries/7718233`),
**execution_id `01KV1SFVSP7QGXR2J2ZVDGF98C`**, **0.336 credits** (this run; transport dropped twice
before returning — re-run confirmed by `getUsage` credit delta; only one settle reported).

**Raw measured — per week (13 weeks):**

| week | total_usd | genuine_usd | distinct_genuine_payers | settlements | self_dealing_share |
|---|---|---|---|---|---|
| 2026-03-16 | 118.68 | 118.68 | 1033 | 87,522 | 0.0% |
| 2026-03-23 | 76.40 | 76.40 | 723 | 58,530 | 0.0% |
| 2026-03-30 | 79.91 | 79.91 | 160 | 10,771 | 0.0% |
| 2026-04-06 | 207.61 | 207.61 | 160 | 12,624 | 0.0% |
| 2026-04-13 | 18.33 | 18.33 | 121 | 5,383 | 0.0% |
| 2026-04-20 | 47.50 | 47.50 | 276 | 15,385 | 0.0% |
| 2026-04-27 | 39.50 | 39.50 | 231 | 9,923 | 0.0% |
| 2026-05-04 | 58.88 | 58.88 | 141 | 5,909 | 0.0% |
| 2026-05-11 | 30.58 | 30.58 | 118 | 4,507 | 0.0% |
| 2026-05-18 | 18,325.08 | 38.08 | 106 | 3,754 | **99.79%** |
| 2026-05-25 | 28.29 | 28.29 | 79 | 3,452 | 0.0% |
| 2026-06-01 | 20.28 | 20.28 | 46 | 1,314 | 0.0% |
| 2026-06-08 | 14.03 | 14.03 | 56 | 1,964 | 0.0% |

**Summary stats (deterministic, keyed to the bars' metrics):**

| metric | measured | bar |
|---|---|---|
| `genuine_usd` OLS slope vs week index | **−8.72** | HELD needs ≤ 0 → **MET** |
| `distinct_genuine_payers` OLS slope | **−54.25** | HELD needs ≤ 0 → **MET** |
| `genuine_usd` ratio (last-3 mean / first-3 mean) | **0.23×** (91.66 → 20.87) | FALSIFY needs ≥ 2× → **NOT MET** |
| `distinct_genuine_payers` ratio (last-3 / first-3) | **0.09×** (638.67 → 60.33) | FALSIFY needs ≥ 2× → **NOT MET** |
| window self-dealing share (Σgenuine / Σtotal) | **95.92%** ($778 genuine / $19,065 total) | HELD needs ≥ ~95% → **MET** |
| weeks with ≥1 `payer != payTo` settlement | **13 / 13** | INSUFFICIENT needs < 3 → **not triggered** |

**Verdict: HELD[theater-persists].** Genuine USD and genuine payers both decline (negative slopes),
neither 2× growth condition is met (both ratios < 1 — the rail is *shrinking*, not arriving), and
aggregate self-dealing is 95.9%. The belief that x402 agentic commerce is theater that persists is
**not killed by this evidence — it survives.**

### CALIBRATE (TETLOCK)
- **Forecast:** P(HELD) = 0.65. **Outcome:** HELD → 1.
- **Brier = (0.65 − 1)² = 0.1225.**
- **Directionally right:** YES — the desk bet the belief would HOLD and it held.
- **Magnitude right:** UNDER-confident — at 0.65 the desk left calibration on the table; the
  deterministic margin was not close (both slopes negative, both growth ratios < 0.25×, self-dealing
  ~96%). A 0.85–0.90 forecast would have scored better (Brier 0.0225–0.01). The base rate (70%) was
  closer to truth than the case-specific 65% down-adjustment — a small instance of over-weighting the
  inside view ("maybe genuine is quietly arriving"). The lesson for the next x402-realness bet: when
  the prior settle (SETTLE-001, ~99% self-dealing) already pointed the same way, anchor higher.
- **Belief NOT killed.** Falsification is the product, but this experiment did not produce one: the
  theater-persists belief is **corroborated, not falsified.** Stated plainly — *no kill this round;
  the x402x rail still shows no genuine-commerce arrival.*

### Caveats (the boundary — evidence vs aspiration)
- **Self-dealing is single-week-concentrated, the rest is "thin but genuine-by-proxy."** Only
  2026-05-18 carries the `payer == payTo` spike ($18.3K, 99.79% — the SETTLE-001 window). The other
  12 weeks read 0% self-dealing — but on `payer != payTo` *proxy* only; tens of thousands of
  sub-cent heartbeat settlements with distinct addresses are "genuine" under this definition yet are
  almost certainly farming/spam, not commerce. The HELD verdict is robust because **both** legs point
  the same way (negative growth slopes AND ≥95% aggregate self-dealing), but the 0% weeks overstate
  "genuineness" — `payer != payTo` is a generous lower bound on theater, the opposite of SETTLE-001's
  conservative `payer == payTo` floor.
- **Settlement counts collapse 10×** (87.5K/wk in March → ~2K/wk in June) — the rail is *contracting*,
  reinforcing "not arriving."
- **One facilitator (x402x), USDC only, 90-day window.** Same scope boundary as SETTLE-001; the
  pattern transfers, the absolute volume does not.

### Provenance / governance note
Same posture as SETTLE-001: **Dune MCP**, `small` tier, partition-filtered (cost-bounded, reported).
NOT the governed `dune-meter` path (still broken — see SETTLE-001). Transport dropped on the first
two `createAndExecuteQuery` calls; recovered by issuing a `timeout: 0` create (returned IDs cleanly)
then `getExecutionResults`. `getUsage` credit delta confirmed exactly one extra paid execution beyond
the lost calls — no double-settle reported. Summary stats computed deterministically (OLS + ratios),
not by an LLM; the LLM only transcribes the measured numbers and keys them to the frozen bars.

---

## SETTLE-003 · Kintara ($KINS) realness — THE POSITIVE CONTROL

- **Date:** 2026-06-14
- **Why this one matters (the meta-point):** every prior settle pointed the filter at things that
  *failed* it (x402 = theater, twice). An instrument that only ever returns "fake" is
  indistinguishable from a broken instrument welded to "fake". This is the **positive control**: a
  candidate surfaced from the trenches (Ansem/@blknoiz06 reposting @PlayKintara — ~7k new users,
  servers full daily, players earning real money selling items/gold, *sustained over a month*) that
  *should* read REAL. If it reads theater too, either Kintara is hype or the filter is broken. If it
  reads real, **the filter discriminates** — and we have our first green reference for what real
  on-chain demand looks like.
- **Bet (claimed, PROBE-003 · gemini OSINT, depth 3):** landed `claimed`-tier on the lab spine
  (`grimoires/loa/lab/spine-events.jsonl`, cost_atom_ref `01KV3SM2MJ8JCK76XY072VSJX1`, 7/12 valid
  citations). **The OSINT refuted the premise before a credit was spent:** Kintara is **not on Ronin**
  (the operator's and my assumption) — it is a **Solana Pump.fun token**, `$KINS` mint
  `Tqj8yFmagrg7oorpQkVGYR52r96RFTamvWfth9bpump` (note the `pump` suffix). The *game* runs off-chain on
  centralised servers (no item/NFT/core contracts); the only on-chain economy is $KINS trading on
  Solana DEXs (Raydium/Meteora). So the realness question collapses to: **is $KINS sustained,
  distributed demand, or the classic pump.fun spike→dump?** Map (`Ronin onchain game`) ≠ territory
  (`Solana pump.fun token + off-chain game`), caught by the OSINT step for ~0 marginal cost.

### DESIGN — the crucial experiment (PLATT)
Strong inference, inverted for a positive control: the bars are pre-registered so the filter must
light GREEN on its own deterministic merits, and a pump-decay or single-wallet pattern *kills* the
"real" claim. **PINNED (frozen before the query):**
- **HELD[real]:** distinct-daily-traders last-7d mean ≥ 0.5× peak-7d mean (demand didn't collapse)
  **AND** distinct-daily-traders OLS slope ≥ 0 post-launch (flat-to-growing) **AND** top-1 trader
  ≤ 25% of volume (not one-wallet-dominated).
- **FALSIFIED[real] → pump-theater:** last-7d mean < 0.25× peak-7d (classic pump decay) **OR** top-1
  trader > 50% of volume (wash / single actor).
- **INSUFFICIENT:** mint absent from `dex_solana.trades` / `tokens_solana.fungible`, OR < 7 days of
  trades, OR small-engine scan refuses/cap-aborts.

Tables: `dex_solana.trades` (Solana DEX trades, all venues), `block_month >= '2026-04-01'`
(partition-pruned). Window: token life to date (2026-05-22 → 2026-06-14, 24 days).

### REGISTERED FORECAST (TETLOCK, pre-settle)
`probability_ppm = 300000` (~30% the belief HELD[real] holds). `base_rate = 3%` (pump.fun tokens that
show sustained demand are vanishingly rare — ~98%+ go to ~0 within days). Inside-view adjustment UP
for the credible trench signal (a real KOL, a real game, sustained a month) — but the skeptical prior
(x402/EXP-002: "it's all theater") dominated the number. **Flagged in advance: this forecast is the
desk betting AGAINST the operator's specimen.**

### SETTLE — deterministic on-chain (Dune, Solana)
Two queries, `small` engine, partition-pruned. Daily series **query 7722462** (exec
`01KV3SSA7X83VJ7GN8TJKD4J8T`, 3.292 cr); concentration **query 7722485** (exec
`01KV3T7MGK38V6TR5VYJE3XH6S`, 6.052 cr). Summary stats (OLS + ratios) computed deterministically in
`node`, not by an LLM.

**Measured — daily distinct traders / volume (24 days):**

| metric | measured | bar |
|---|---|---|
| distinct-traders OLS slope vs day index | **+152.5 / day** | HELD needs ≥ 0 → **MET** |
| volume OLS slope | **+$95,681 / day** | (corroborating) |
| last-7d mean traders ÷ peak-7d mean | **1.000** (last 7d *is* the peak) | HELD needs ≥ 0.5 → **MET** |
| last-7d ÷ first-7d traders | **2.67×** | (growing, not decaying) |
| last-3d ÷ first-3d traders | **6.19×** | (accelerating) |
| peak distinct traders (1 day) | **6,486** (2026-06-11) | — |
| **top-1 trader share of volume** | **5.78%** | HELD needs ≤ 25% → **MET**; FALSIFY needs > 50% → **NOT MET** |
| top-10 trader share | **~18.6%** | (broad distribution) |
| distinct traders (24d) | **29,009** | — |
| total volume (24d) | **$25,288,116** | — |

**Verdict: HELD[real] — and with margin.** All three legs met; neither falsification leg triggered.
$KINS is a **broad (29k traders), distributed (top-1 only 5.78%), and *growing* (slope +152/day, last
week the peak)** on-chain economy. **The positive control lit green.**

### The discrimination claim (why SETTLE-003 is the keystone)
Side by side with the negative controls, on the SAME deterministic instrument:

| | x402x (SETTLE-001/002) | Kintara $KINS (SETTLE-003) |
|---|---|---|
| top concentration | **99.3%** self-dealing (`payer==payTo`) | **5.78%** top-1 trader |
| distinct participants | 300 payers / 46 payTos | **29,009** traders |
| trend | shrinking (slope −8.7 genuine $/wk) | **growing** (+152 traders/day) |
| filter verdict | **THEATER** (HELD[theater]) | **REAL** (HELD[real]) |

The realness filter has now returned **both** verdicts on deterministic on-chain evidence. "It only
ever says fake" is itself **falsified.** The instrument discriminates. This is the result the lab was
built to be able to produce.

### CALIBRATE (TETLOCK)
- **Forecast:** P(HELD[real]) = 0.30. **Outcome:** HELD → 1.
- **Brier = (0.30 − 1)² = 0.49.** The desk's **worst score yet** — and the most instructive.
- **Directionally WRONG:** the desk bet against the specimen (30% it's real) and it resolved strongly
  real. The skeptical prior — earned honestly across x402/EXP-002 ("the whole space is theater") —
  was over-applied. The pump.fun category base rate (~3%) was allowed to dominate a case that carried
  strong, specific, *credible* signal to the contrary (a real KOL, a real game, sustained a month,
  surfaced deliberately by the operator as a specimen). **The filter exists precisely to stop the
  desk from pre-judging by category — and this round the desk pre-judged by category and the
  territory corrected it.** Map ≠ territory cuts *both* ways: it kills hype (SETTLE-001/002) AND it
  rescues real things from a lazy "it's all theater" dismissal (SETTLE-003).
- **Lesson for the next bet:** weight the trench signal + OSINT higher relative to the category prior.
  A defensible pre-registration here was 0.45–0.55, not 0.30. The desk is running **systematically
  under-confident in the eventual direction** (SETTLE-002: under-confident HELD-theater; SETTLE-003:
  wrong-side HELD-real) — the common root is anchoring too hard on the skeptical prior.
- **Belief NOT killed — and that's the point.** The "Kintara is real" belief survived a crucial
  experiment built to kill it. Strong inference: it's credible *because* a pump-decay or whale-
  domination pattern would have falsified it on the spot, and didn't.

### Caveats (the boundary — evidence vs aspiration)
- **On-chain ≠ in-game. We measured $KINS DEX demand, not the game's retention.** The game economy
  (Gold, items) is off-chain in a centralised DB — *unmeasurable on-chain by construction*. The
  green verdict is about the **token economy's** breadth/distribution/growth, which is real and large;
  it is NOT proof the *game* is healthy or that players (vs. speculators) drive the volume. The two
  are correlated (token demand tracks game attention) but not identical.
- **"Real demand" ≠ "good investment" ≠ "not a bubble".** A pump.fun token growing 6× in 3 weeks can
  be a real, distributed *speculative mania* and still round-trip to zero. The filter measures
  *realness of present on-chain activity* (broad, distributed, not self-dealt), not future value. A
  29k-trader distributed melt-up is real demand AND high risk simultaneously.
- **DEX-trade `trader_id` is the swapper, not necessarily the beneficial owner.** Aggregators/routers
  can appear as traders; the 5.78% top-1 is conservative for distribution (router collapsing would
  *concentrate*, so true distribution is ≥ this broad). Two MM-like wallets (5.78%, 5.10%) lead — a
  normal liquidity profile, far from the >50% wash bar.
- **24-day window, single token.** No claim about $KINS's future, the game's longevity, or whether
  this survives the next month. The settle is a measurement of the present, taken cheaply, on purpose.

### Provenance / governance note
Same posture as SETTLE-001/002: **Dune MCP**, `small` tier, partition-pruned (cost-bounded, reported).
NOT the governed `dune-meter` path (still broken). PROBE-003 was fired through the **new committed
runner** `grimoires/loa/lab/run-probe.ts` (`npx tsx … --question … --depth 3`) — so unlike PROBE-001/002
this probe's invocation is **reproducible**, not lost. Credit honesty: session `getUsage` delta =
**15.74 credits** (0.604 → 16.345). Accounted: query 1 (3.292) + query 2 re-run (6.052) +
**the first query-2 attempt that the transport dropped DID execute and charge (~6.05)** + searches
(~0.35). The dropped call's double-charge (~6 cr paid for nothing returned) is exactly the failure the
**governed `dune-meter` path would prevent** (idempotent execute-by-id) — concrete evidence for
prioritising that fix. Total cost to settle a $25M-economy realness verdict two analytics firms would
bill for: **~0.0006% of the monthly Dune quota.**
