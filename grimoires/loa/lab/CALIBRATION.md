# Calibration Ledger — the appraiser appraises itself

> **What this is — and is NOT.** This is a **retrospective scoring demo + a baseline**, run to
> dogfood loa-finn's calibration engine on its own decision trace. It is **not** a calibration
> track record: every prediction here was **reconstructed post-hoc** (none logged before the
> outcome), and only **2 of 7** scored decisions were resolved by an instrument independent of the
> prediction (the real ladder). `evidence_class = retrospective-demo`, `headline_eligible = false` —
> the engine itself refuses to call this calibration evidence. The value is the **method** and an
> **honest accounting of how thin the clean evidence is**, not a verdict that "we are calibrated."

The lab's reflexive ledger. SETTLES.md grades *claims about the world* (is this on-chain economy
real?). This grades **loa-finn's own decisions** — were our *predictions* well calibrated against
what later proved true? "Grade the record, not the outcome," turned on ourselves.

- **Engine:** `src/research/calibration.ts` (resolve → Brier → tiered report) + the schema
  `src/research/schemas/decision-forecast.ts`. The missing mechanical piece — Brier scoring had
  only ever been done by-prompt; it is now a deterministic, tested function.
- **Ledger:** `grimoires/loa/lab/cabt-calibration.jsonl` — 8 hash-chained records.
- **Source dataset:** the cabt session (`grimoires/loa/context/2026-06-18-cabt-research-findings.md`,
  §8). Brier convention: **0 = perfect, 0.25 = a coin-flip, 1.0 = maximally wrong; lower is better.**
- **Hardened by a headless 3-model review** (codex + gemini + claude, 2026-06-17). Their pushback
  reshaped this ledger — the irony that a ledger about not-overclaiming first overclaimed is the
  finding earning its keep. Findings folded below.

---

## CALIBRATION-001 · the cabt session decision trace

- **Date scored:** 2026-06-17 (decisions made 2026-06-17 / 18; ladder resolutions 2026-06-18).
- **What it is:** 8 build decisions, each a falsifiable proposition + a **prediction-at-the-time**,
  resolved (where possible) against the **real target** (the Kaggle ladder).

### The bets (per-decision)

`tier`: **OBJ** = resolved by the real ladder (independent of the prediction → calibration
evidence) · **REF** = self-resolved by the same local eval/reasoning that produced the prediction
(reflection, *circular*, not evidence) · **SUBJ** = a framing/imported call (no measurement under it).

| # | decision | tier | effect | p | proposition resolved | outcome | Brier |
|---|----------|------|--------|---|----------------------|---------|-------|
| 2 | ship the PIMC floor | **OBJ** | large | 0.90 | live, v2 = 585.7 (valid baseline) | held | 0.010 |
| 7 | **ship FunSearch v2 heuristic** | **OBJ** | large | 0.77 | ladder **648.1** — only agent above μ₀=600 | held | 0.0529 |
| 4 | **ship n_worlds=16** | **OBJ** | small | 0.65 | ladder 539.4 < n4 585.7, but §5b: below eval resolution (noise) | **insufficient** | **— unscored** |
| 3 | reject card-aware augury | REF | large | 0.85 | local gate: 0.30 vs 0.70 (killed) | held | 0.0225 |
| 6 | reject FunSearch v1 (blind) | REF | large | 0.90 | local gate: 0.17 vs greedy (killed) | held | 0.010 |
| 5 | reject Lucario / mono-F decks | REF | large | 0.80 | local + deck⊗engine reasoning | held | 0.040 |
| 1 | build in-repo, not a worktree | SUBJ | framing | 0.30 | corpus infra absent on main (structural fact) | held | 0.490 |
| 8 | **"deck is the lever" (imported)** | SUBJ | framing | 0.70 | FALSIFIED for our weak pilot | falsified | 0.490 |

### The aggregate (computed, `calibrationReport`)

| metric | value |
|---|---|
| decisions / scored / insufficient | 8 / 7 / 1 |
| outcomes | held 6 · falsified 1 · insufficient 1 |
| `evidence_class` / `headline_eligible` | **retrospective-demo / false** |
| scored prediction basis | logged 0 · **reconstructed 7** |
| **OBJECTIVE (ladder-measured — the only evidence)** | n=3 → **2 scored, mean Brier 0.0315** · 1 insufficient |
| REFLECTION (proxy + structural — self-resolved) | 5 scored, mean Brier 0.211 |
| blended mean (illustrative only — do NOT headline) | 0.159 |
| over-confident-vs-resolution | **ship-n-worlds-16** (the one excluded ladder result) |
| weakest scored resolution-trust | 2 (no scored row rests on operator opinion) |

### The reading — honest version

**The genuine out-of-sample evidence is n=2.** Only #2 (PIMC floor) and #7 (FunSearch v2) were
scored against the *real ladder* — an instrument independent of the prediction. Both held; mean
Brier **0.0315**. That is **consistent with** good calibration on large, ladder-confirmed effects —
it is **not enough to claim it** (n=2, reconstructed `p`). The keystone (#7: a grounded LLM-authored
heuristic beats our search, predicted on a 0.77 local edge, confirmed at 648.1 on the ladder) is the
one result that genuinely transferred — the §5b "large effects transfer" rule, on its single clean
data point.

**The "calibrated on large effects (0.027)" story is mostly circular.** The large-effect bucket is
n=5, but #3/#5/#6 are *self-resolved*: each was scored against the **same local eval that generated
its prediction** (evidence "0.30 vs 0.70" → resolution "killed locally"). Scoring a prediction
against the measurement it was derived from is tautological — of course the Brier is ~0.01–0.04.
Strip the circular rows and only #2/#7 remain. So the headline is the OBJECTIVE tier (n=2), **not**
the large-effect bucket. The reflection tier (mean 0.211) shows the local gate and the reasoning
were *internally* sound; it says nothing about the real target.

**Abstention, surfaced — not buried.** n_worlds=16 was a confident directional bet (p=0.65) shipped
to a submission; the ladder gave a 46-point gap the *wrong* way (539.4 < 585.7). It is scored
`insufficient` (unscored), on the §5b argument that n4≈n16 is below any feasible-N eval's
resolution. **Two honesty caveats:** (a) this is the single *disconfirming* ladder point, and the
"it's noise" justification is **in-sample** (§5b came from the same session; no independent ladder-
variance estimate). A skeptic cannot fully distinguish principled abstention from convenient
exclusion. (b) The engine refuses to hide it: it is flagged `overconfident_vs_resolution` and that
count sits **next to** the headline, not in a footnote. The mechanical lesson stands regardless:
never burn a submission on a locally-indistinguishable tweak.

**Framing is the appraiser's blind spot — but these are not measurements.** The two SUBJ calls
(0.49 each) are the worst scored Brier: the agent's own worktree-lean (#1 — the operator out-framed
it; resolved by the objective infra fact, not the operator's opinion) and an imported "deck is the
lever" belief (#8 — falsified for our pilot, the grounding sin at the belief level). These are
**bucket-only** and excluded from the headline: a Brier on a non-measurable proposition with an
analyst-invented `p` is a number with no measurement under it. They are qualitative reflection.

### What this means for loa-finn

- **We have almost no clean calibration evidence yet (n=2, reconstructed).** That *is* the finding.
  The instrument works; the dataset to validate it against barely exists. The forward fix is the
  whole point: **log `p` BEFORE the ladder speaks** (the `forecast-registry.ts` pre-registration
  guard), resolve against the **real target**, and accumulate ladder-resolved rows until the
  OBJECTIVE tier is large enough to make a calibration claim.
- **Calibrate the appraiser before scaling the generator** — sharpened: the eval is a trustworthy
  *coarse pre-filter* (it transferred on the one clean case), framing/imported beliefs stay a
  human-judgment lane (and imported beliefs must be re-grounded to our context before earning a
  prior), and small effects defer to ladder-scale N. The council (the generator) can then land on a
  yardstick whose resolution band we understand.

### Caveats — the honesty boundary (expanded after review)

1. **All 8 predictions are RECONSTRUCTED post-hoc** (`scored_prediction_basis.logged = 0`). Post-hoc
   `p` is hindsight-bias-prone — the bias pre-registration exists to defeat. This bars headline
   calibration language (enforced: `headline_eligible = false`).
2. **Three analyst-chosen knobs per row (`p`, `effect_size`, `outcome`) over n=8 make the
   three-regime story partly *constructed*, not discovered.** There is no pre-registered
   decision→effect_size rule, and the pivotal `small` label on n_worlds is what licenses excluding
   the one disconfirming ladder point. With that joint freedom, few results *couldn't* be rendered
   "calibrated." Treat the regimes as a hypothesis from one session's trace, not a measurement.
3. **The large-effect bucket is circular** (evidence-instrument = resolution-instrument for #3/#5/#6).
   Only the OBJECTIVE tier (ladder-measured) is independent. See "mostly circular" above.
4. **The §5b noise claim (used to abstain on n_worlds) is in-sample.** No independent ladder-variance
   figure backs "the 46-point gap is noise."
5. **n = 8** is tiny; bucket means (esp. SUBJ, n=2) are illustrative.

---

## CALIBRATION-002 · the forward fix — pre-registered cabt decisions (LOGGED, awaiting the ladder)

CALIBRATION-001 had only n=2 genuine out-of-sample evidence, all reconstructed. This is the fix:
**three real, open cabt decisions, forecast PRE-OUTCOME** — `p` logged *now* (2026-06-17), before any
eval or submission, with a ladder-resolvable criterion. (Pre-outcome priors, not "blind" in the
experimental sense — they draw on deep prior cabt work; pre-registration requires only that the
*outcome* is unknown when `p` is fixed, not ignorance of the domain.) They are the first
`prediction_basis: "logged"` records in the lab. Registry: `grimoires/loa/lab/cabt-forecasts.jsonl`
(head `7e3639322c2f…`, len 3). Rebuild (idempotent; `--force` to deliberately rewrite a published
registry): `npx tsx src/research/cabt-pre-register.ts --write`.

| decision | p (blind) | predicted effect | the bet (resolved against the ladder) |
|---|---|---|---|
| `deck-lucario-with-heuristic-pilot` | **0.45** | large | Mega Lucario ex + heuristic pilot beats heuristic+sample (648.1) — the deck⊗engine retest now that the pilot is competent |
| `heuristic-v5-energy-target-attach` | **0.40** | small | a v5 energy-target attachment refinement clearly beats v4 (648.1) — I bet it's below ladder resolution |
| `deeper-ismcts-vs-heuristic` | **0.25** | large | a deeper ISMCTS beats the heuristic — I bet AGAINST (the dig: search < heuristics here) |

**Honesty about what this does and does NOT do.** This grows the OBJECTIVE *pipeline* by 3 logged
forecasts; it does **not** grow the objective *scored* count — that stays 2 until the ladder speaks.
Nothing is resolved this session (the ladder accumulates over days, after a submission). The value is
that these are the FIRST predictions that will resolve as genuine calibration evidence (logged before
outcome), not retrospective scoring.

**Discipline:** `p` was assigned PRE-OUTCOME — deliberately without running the local self-play eval
first. Peeking at the margin before logging `p` would contaminate the "logged before outcome"
guarantee. The local eval is a downstream coarse pre-filter; the ladder is the resolver.

**How the evidence becomes visible (the H1 fix).** Resolutions land in a SEPARATE evidence ledger,
`grimoires/loa/lab/cabt-calibration-logged.jsonl` — NOT the retrospective `cabt-calibration.jsonl`.
This is load-bearing: `headline_eligible` requires *every* objective-scored row to be `logged`, so
co-mingling the 3 logged bets with the 8 immortal reconstructed rows would pin the headline to
`retrospective-demo` forever — the forward fix's payoff would be structurally unreachable. A report
over the clean evidence ledger flips to `calibration-evidence` as the bets resolve. (`calibrationReport`
also exposes an **`evidence` bucket = objective AND logged** for any mixed report.)

**Why these p's (the bets are mostly skeptical, logged):** two of three bet *against* a clear ladder
win — a v5 refinement (small effect → §5b says it likely won't resolve) and deeper search (the dig
found heuristics beat search here). If they surprise me, my low `p` is penalized; if they confirm,
it scores well. That asymmetry is the calibration test working forward.

**Resolution (the "ladder speaks" step):** when a submission's ladder score settles, run
`resolveRegisteredDecision(id, {resolution_instrument:"ladder-measured", ground_truth, outcome},
observedMarginPpm)`. Guards: the franchise rule refuses any decision_id that was not pre-registered;
the registry's hash chain is verified before it is trusted (a tampered registry is refused); the
prediction is used verbatim; a ladder-measured ship/reject requires a numeric margin (a null margin
would dodge the effect rule as "framing"); a second resolution is refused (scored once). `effect_size`
is set MECHANICALLY from the observed margin (`classifyEffectFromMargin`, the M5 fix). The resolved
record lands on the separate **`cabt-calibration-logged.jsonl`** evidence ledger and carries a
`registered_entry_hash` binding it to its immutable registration — so the scored `p` is provably the
logged `p`.

**Trust root:** the integrity guarantee is GIT-COMMIT PRECEDENCE — the commit that *registers* a
forecast must precede the commit that *resolves* it. The hash chain, the committed registry anchor
(`EXPECTED_REGISTRY_HEAD` / `7e3639322c…`), and the `registered_entry_hash` binding are defense-in-depth
that make a post-hoc edit DETECTABLE; git history is what makes "logged before the outcome" auditable.
(`created_ts` and the "no eval run first" discipline are asserted in code, not mechanically enforced —
they too reduce to git timing + author honesty. Stated plainly so the caveat isn't buried.)

---

### Integrity / reproducibility

- **Deterministic snapshot.** Stable `decision_id`s + fixed `Date.parse` timestamps (never `now()`),
  no randomness → the ledger re-hashes identically. Rebuild (idempotent — atomic replace, safe to
  re-run): `npx tsx src/research/cabt-calibration-seed.ts --write`. Head `entry_hash` should be
  `e4dbbb51596c…` over **8** records.
- **Tamper scope (not overstated).** A *middle* delete, a reorder, or any in-place
  tamper-without-rehash breaks `verifyCalibrationChain`. **Tail truncation** (dropping the last k
  records) and a **full rewrite with recomputed hashes** do NOT — they need the external anchor:
  `verifyCalibrationChain(envelopes, { expectedHead: "e4dbbb5159…", expectedLength: 8 })` (head +
  length committed here, in the doc). Use `verifyCalibrationLedger` for chain + semantic validity.
- 30 passing tests (`src/research/calibration.test.ts`); tsc clean.
