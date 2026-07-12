---
status: candidate
created: 2026-06-10
author: session 365651f6 (EXP-002 interview round, operator-paced)
promotes_via: operator approval — this is a CANDIDATE brief per the crystallization protocol
hivemind:
  schema_version: "1.0"
  artifact_type: technical-rfc
  product_area: "Finn — experiment program epistemology (truth through deterministic layers)"
  workstream: experimentation
  priority: high
  jtbd: {category: functional, description: "score learnings honestly so the program can steer by learning-yield instead of vibes"}
  learning_status: directionally-correct
  source: team-internal
grounding:
  - "feedback_truth-ground-up-stack.md — operator-signed load_bearing · use_label usable (the five-layer stack is AUTHORITY here, not background)"
  - "reference_worldline-temporal-spine.md — operator-validated · background"
  - "ACVP vault page — activation receipt in session 365651f6, use_label background_only (shape orientation ONLY)"
  - "maxbittker Fable-vs-Opus measurement-register observation (operator-supplied image, 2026-06-10)"
  - "EXP-001 readout + EXP-002 SEAM 1 ratifications (sha-pinned artifacts)"
---

# Epistemology — Determining Truth Through Deterministic Layers (candidate)

> The operator's ask (EXP-002 interview, 2026-06-10): *"what we learn and what we
> can claim with truth starts from the bottom up… it gets lossy through layers of
> lies and abstraction. Truth first before anything."* This brief applies the
> already-ratified truth stack to the experiment program, so "learnings" can be
> scored instead of vibed.

## 1. The floor is already law

The five-layer truth stack is standing operator doctrine (signed `load_bearing`,
`usable` — it bears weight here):

```
5  straylight   governance — claimed → attested → canonical · agents never self-promote
4  WORLDLINE    time — no present-tense claim without an observed feeder
3  epistemology knowing — every claim tagged observed | claimed · confidence tracks grounding
2  onomatology  naming — type + scope in the name · wrong name ⇒ wrong reasoning downstream
1  proofs       measurement — read the number, don't recall it · deterministic instruments
```

This brief adds the **research-program projection** of that stack — nothing below
replaces it.

## 2. The program mapping (what EXP-001/002 already do, named)

| Stack layer | Program instrument |
|---|---|
| proofs | sha-pinned bars · readout instruments (`exp2_readout.py`) · reconciliation gates (`reconciliation.json` — facts may not exist downstream of a FAIL) · zero-inference SQL+stdlib verdict paths |
| onomatology | the L0–L4 fact ladder + `vocabulary: gross\|net-est\|subsidy` — every fact row names its tier and its money-meaning; `claimed` is itself a tier (Eileen's doc enters as CLAIMED, never as fact) |
| epistemology | the spine's **register / settle** vocabulary — a belief is REGISTERED (bars pinned) then SETTLED (verdict from an instrument); nothing else counts as "learned" |
| worldline | experiment events carry dates + artifact citations; the spine is append-only; readouts pin the bars sha so "what was believed at T" is reconstructable |
| straylight | operator ratifies bars (SEAM 1), attests readouts (SEAM 3), promotes learnings — the agent is the hands |

## 3. The measurement register (new — admitted this session)

Evidence: the Fable-vs-Opus vocabulary analysis (maxbittker, 2026-06-10). The
stronger agent **states measurements** ("20,120 XP/min · Strength 10→42"); the
weaker one reaches for **abstract comparatives** ("faster, better, optimized").
The difference is not style — it is falsifiability. A comparative cannot be
wrong; a measurement can.

**Doctrine:** a claim is admitted as a *learning* only when stated in the
measurement register — **a number, with units, with a window, with provenance.**
"Wash trading is rampant" is a vibe; "per-job value fell 76% while job count rose
22% (epochs 1→5, platform API, CLAIMED tier)" is a candidate fact. Two corollaries:

- **Agents are not equal, and the system must not assume rigor** — it must
  *enforce the register* at admission time (schema-checked fact rows, not prose).
  This is why SCHEMA.md exists and why L4 rows are the only rows allowed to
  abstain from a `dune_query_id`.
- **Lossiness through layers is the default, not the exception** — every
  abstraction step (fact → synthesis → comm) must carry provenance + confidence
  forward (straylight stickiness), or the top of the stack is fluent fiction.

## 4. The construct pipeline (epistemic roles, named)

```
GECKO   senses        what is happening          L0/L1 observation · drift detection
GYGAX   models        what game produced it      incentive analysis · dominant strategies
OSTROM  reads         what rules could change it institutional analysis · governance
FAGAN   attacks       does the claim survive     adversarial review · cross-model councils
```

LLM permission boundary: **models generate hypotheses, syntheses, and attacks;
models never settle verdicts.** Verdicts come only from deterministic instruments
compared against pre-registered bars (the ACVP shape: agents reason, substrate
verifies — background doctrine, receipt in frontmatter). Cross-model councils
exist because a council of one corpus is one blind spot voting N times.

## 5. Program commitments (ratified 2026-06-10, EXP-002 interview)

1. **Position = the package.** Trust-layer referee, rails-native builder,
   positioning intelligence, agent operator — four dimensions of one game; the
   experiments are the calibration instrument that tells us where to weight.
2. **Game stance = AUDITOR ONLY.** We measure games others run; we do not own a
   metric. This is an *epistemic* commitment, not just a GTM one: owning the
   score creates an incentive to bend it. (Referee/mechanism-design recorded as
   explicitly rejected-for-now, revisit only via a new decision artifact.)
3. **Publication = internal first.** Verdicts steer us now; the fact sheet
   publishes when battle-tested. Bar for internal: reproducible + abstaining.
4. **Steering metric = learning yield.** `Σ settled beliefs (tier-weighted) /
   cost (credits · tokens · operator attention)` — numerator admits only
   measurement-register learnings; experiment-economics.md holds the running
   ledger.

## 6. Open questions (the brief does not pretend these are settled)

- **Tier weights** for the numerator (is an L2 structural settle worth 3× an L1?
  proposal: weights are themselves pre-registered before the next readout).
- **Decay**: does a settled belief expire? (worldline says yes — a 2026-Q2 verdict
  about aGDP is a dated fact, not a permanent one; propose `settled_until` or
  re-verification triggers on regime change.)
- **Attestation surface**: where does the operator sign a settle? (currently
  SEAM 3 + spine commit; a worldline `attested` beat would be cleaner.)
- **Cross-program reuse**: EXP-001's instrument learnings (pricing staleness,
  vCPU 2×) settled OUTSIDE any registered bar — incidental learnings need an
  admission path that doesn't pretend they were pre-registered.
