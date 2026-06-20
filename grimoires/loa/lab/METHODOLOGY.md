---
status: brief
created: 2026-06-13
cycle: cycle-053
task: bd-8ywq.10
hivemind:
  schema_version: "1.0"
  artifact_type: technical-rfc
  product_area: "loa-finn — the Agent R&D Lab: the loop (METHODOLOGY)"
  workstream: experimentation
  priority: high
  jtbd: {category: functional, description: "run a belief from grounded probe to deterministic settle to calibrated score — metered, falsifiable, on the spine"}
  learning_status: directionally-correct
  source: team-internal
scope_note: "V1 loop is HUMAN / main-loop-orchestrated (spec §F). No automated /compose routing claimed — the desks are briefs + a manual handoff. Every primitive cited is a file that EXISTS and was read."
---

# METHODOLOGY — how the lab runs

> A metered, falsifiable probe — grounded, not guessed. The map is not the
> territory; the meter is how we touch the territory cheaply. **Atomic cost every
> step. The spine is the record. Falsification is the product. Map ≠ territory.**

## The loop (one page)

```
   ┌──────────┐   ┌───────────┐   ┌──────────┐   ┌──────────┐   ┌───────────┐
   │  PROBE   │──▶│  REGISTER │──▶│  DESIGN  │──▶│  SETTLE  │──▶│ CALIBRATE │
   └──────────┘   └───────────┘   └──────────┘   └──────────┘   └───────────┘
    sensor →        claimed-tier     Platt:          DETERMINISTIC   Tetlock:
    grounded,       event on the     crucial exp     instrument —    Brier-score
    cited,          spine, cites     + pre-reg       on-chain /      the forecast
    METERED         the cost atom    bars            test / market
                                                     P&L — NEVER
                                                     an LLM
```

### 1 · PROBE — sensor → grounded, cited, metered
`probe(question, { sensor, freshness_max_age })` → a metered, grounded,
attributed finding, or an honest abstention.
**Primitive:** `src/research/probe.ts` :: `probe()`.
- The finding is the resolved value of `runMeteredResearch()`
  (`src/research/cost-atom-research.ts`), which closes a hash-chained CostAtom
  **before** the finding is representable — a finding without a closed atom is
  *unrepresentable*, not merely discouraged (Contract A). The cost is surfaced via
  `onCostSurfaced` BEFORE the finding; the `budget_reservation` (estimate) is
  written first, the `actual_cost` after.
- The **grounding gate** (`validateCitations()`, Contract D) checks citation
  QUALITY — linkrot (2xx), circular (citation domain ≠ question source), freshness,
  confidence — not a raw count. Zero valid citations → `finding_class:
  "insufficient"`, finding withheld (`null`). Abstain over fabricate.
- **Provider honesty** (Contract B): a finding served by a different provider than
  asked is `routing_fallback` (`isRoutingFallback()`), surfaced but NEVER counted
  as evidence the intended provider works (the 0/758-Bedrock trap, closed).
- **Sensors** (`src/research/sensors/`): Gemini OSINT is wired
  (`makeGeminiDigSearchSensor` shells k-hole's `dig-search.ts`, subscription/flash,
  `cost_micro: 0n`); Grok SIGINT (`makeGrokSensor`) and Dune on-chain
  (`makeDuneSensor`) are key-gated / Asson-CLI scaffolds — absent infra is a TYPED
  `SensorUnavailableError` (cost 0), never a silent failure.

### 2 · REGISTER — claimed-tier event on the spine
A grounded, attributed finding lands as a `claimed`-tier bet on the Ledger of Bets.
**Primitive:** `src/research/spine-ledger.ts` :: `SpineEventWriter.append()`,
emitting `src/research/schemas/spine-event.ts :: ResearchSpineEvent` (`kind:
"probe"`, `tier: "claimed"`, `cost_atom_ref` linking the metering atom — *a probe
without a `cost_atom_ref` didn't happen*). The ledger is append-only, advisory-
`flock`'d, `fsync`'d JSONL; `verifySpineChain()` proves the record intact. Only a
genuinely `claimed` finding lands — `insufficient` and `routing_fallback` do not
enter the Ledger of Bets, so the spine stays honest.

### 3 · DESIGN — Platt: the crucial experiment + pre-registered bars
Before a settle can run, **PLATT** (the Kill Switch — `roster/platt.md`) writes the
crucial experiment whose deterministic outcome would FALSIFY the claim, and pins
the pass/fail bar in advance.
**Primitive:** the bar is `tetlock-forecast.ts :: TetlockForecast.resolution_criterion`,
and the kill is a first-class outcome in the type itself — `ForecastOutcome =
"held" | "falsified" | "insufficient"`. A kill is a result, not a failure.

### 4 · SETTLE — DETERMINISTIC instrument, NEVER an LLM
The pinned bar is checked against a **deterministic** instrument — on-chain read,
test, or market P&L. **No LLM settles a verdict** (`epistemology-deterministic-
layers.md` §4: *models generate hypotheses, syntheses, and attacks; models never
settle verdicts*).
- **On-chain settle:** `src/research/sensors/dune.ts :: makeDuneSensor` shells the
  cost-capped `dune-meter` CLI (mandatory `--cap`, `inference_micro: 0n` — DATA, not
  inference). For the agentic-commerce-realness domain this is the PRIMARY settler:
  on-chain settlement is where "is this real?" gets a deterministic answer.
- **Market P&L is a legitimate settler.** THE BOX's self-funding agent P&L is a
  deterministic settle — a self-funding agent cannot fake working; its ROI is the
  substrate's conformance signal (spec § Context; `kickoff-the-box.md`).

### 5 · CALIBRATE — Tetlock: Brier-score the forecast
After the deterministic settle, **TETLOCK** (the Calibration Desk —
`roster/tetlock.md`) records the outcome and the Brier score on the forecast.
**Primitive:** `tetlock-forecast.ts :: TetlockForecast` (`outcome`, `brier_ppm`
— integer parts-per-million, no stored floats; `attestation: null` reserves the
future ERC-8004 / Echelon regime-13 seam — wire, don't build). The score feeds the
program's steering metric, learning yield (`epistemology-deterministic-layers.md`
§5).

## The laws (every step)

| Law | Mechanism (cited) |
|---|---|
| **Atomic cost, always** | `runMeteredResearch()` closes a hash-chained `ResearchCostAtom` BEFORE any finding returns (`cost-atom-research.ts`, Contract A). A probe that doesn't emit one didn't happen. Hard ceiling `MAX_MICRO_USD_PER_PROBE` → `ProbeCeilingError` auto-abort. |
| **The spine is the Ledger of Bets** | `SpineEventWriter` append-only JSONL, hash-chained, `flock`'d, `fsync`'d (`spine-ledger.ts`, Contract C). Every belief is `claimed` until a deterministic instrument settles it; agents never self-promote. |
| **Falsification is the product** | The loop earns its keep on the KILL — `ForecastOutcome` makes `falsified` a first-class result (`tetlock-forecast.ts`). The box's negative-ROI-on-a-request is a *located* conformance failure. |
| **Map ≠ territory** | Green-in-memory ≠ consumed-in-reality. The probe cites the reality, not the doc; the grounding gate (`validateCitations`) rejects ungrounded assertion. Trends/beliefs converge slowly — the probe keeps the lab grounded in real-time reality while they do. |
| **No LLM in SETTLE** | Settlement is deterministic (on-chain / test / market P&L). Models reason; the substrate verifies (`epistemology-deterministic-layers.md` §4). |
| **Spend counted once** | `reconcileSpend()` dedups Cheval-routed LLM spend via `modelinv_ref` so a single call's dollars appear EXACTLY ONCE across the research ledger and MODELINV (`cost-atom-research.ts`, Contract E #4). |

## V1 scope — human-orchestrated (spec §F, DECISION)

**The loop is human / main-loop-orchestrated in V1.** The desks (TETLOCK, PLATT,
JOBS) are persona **briefs** under `roster/`, not full construct manifests — so
`construct-resolve.sh` / `/compose` **cannot route the loop automatically.** This
document does NOT claim automated `/compose` routing.

The manual handoff between desks:

```
operator/main-loop:  probe(question)                         → PROBE   (probe.ts runs; cost surfaced)
operator/main-loop:  read the claimed event off the spine    → REGISTER (spine-ledger.ts)
operator-as-PLATT:   write the crucial experiment + bar       → DESIGN  (resolution_criterion)
operator/main-loop:  run the deterministic instrument         → SETTLE  (dune-meter / test / P&L)
operator-as-TETLOCK: record outcome + Brier score             → CALIBRATE (TetlockForecast)
```

Each desk's brief is its handoff contract — what it owns, what it must not touch
(the desk never settles its own verdict). **Stub `construct.yaml` manifests
(name, role, owned_dimension, allowed_skills) are a V2 graduation**, added when the
loop is actually composed via `/compose`. **On-deck desks** (named, not built in
V1): Commerce / Distribution (Coinbase / Base / x402) and Craft-Velocity (Linear /
Ramp); DUGAN and POPPER remain on-deck.

## Read next

- `roster/tetlock.md` — the Calibration Desk (REGISTER + CALIBRATE)
- `roster/platt.md` — the Kill Switch (DESIGN + the deterministic SETTLE bar)
- `roster/jobs.md` — the Product/Ship Desk (what's worth running at all)
- `grimoires/loa/context/epistemology-deterministic-layers.md` — the lab's law
- `grimoires/loa/specs/enhance-agent-rnd-lab.md` — the source-of-truth spec
