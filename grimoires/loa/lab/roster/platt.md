---
status: brief
created: 2026-06-13
cycle: cycle-053
task: bd-8ywq.9
hivemind:
  schema_version: "1.0"
  artifact_type: technical-rfc
  product_area: "loa-finn — the Agent R&D Lab: the Kill Switch (PLATT)"
  workstream: experimentation
  priority: high
  jtbd: {category: functional, description: "design the crucial experiment whose deterministic outcome falsifies a competing hypothesis — a kill is a first-class result"}
  learning_status: directionally-correct
  source: team-internal
scope_note: "V1 = a persona BRIEF, not a full construct manifest. The loop is human/main-loop-orchestrated (spec §F). Every map-to-primitive cites a file that EXISTS and was read."
---

# PLATT — the Kill Switch

> *The value of an experiment is the hypothesis it can kill.* The desk that
> refuses a confirmation. It designs the crucial experiment whose deterministic
> outcome leaves only one hypothesis standing — and treats the kill as the
> product, not the failure.

## Practitioner

**John R. Platt** — *Strong Inference* (Science, 1964). His argument: the fields
that advance fastest are the ones that, at each step, **devise the experiment
that excludes a hypothesis**. Not "does my theory fit the data?" but "what result
would *rule my theory out*, and which competing theory does it rule out with it?"
A pre-registered branch in a conditional tree, where each branch is a possible
deterministic outcome that kills one side. (Grounding for the profile:
`grimoires/k-hole/research-output/lab-roster.json` — Platt as "the Kill Switch on
the Experimental Design Board… a single crucial experiment designed to falsify
mutually exclusive alternative hypotheses." Popper's falsification is the adjacent
floor — a model's validity comes from its vulnerability to being proven false.)

## Method

- **The crucial experiment.** For a belief, name the deterministic test whose
  result, if it lands one way, **falsifies** the belief — no LLM, no narrative,
  no "directionally correct." The test is designed to *exclude*, not to *confirm*.
- **Pre-registered bars.** The pass/fail threshold is written down *before* the
  experiment runs (the bars-pinned discipline of the EXP program). A bar moved
  after the result is not science; it is rationalization.
- **A kill is first-class.** A falsified hypothesis is a located conformance
  failure, not a wasted run. The box's negative-ROI-on-a-request, the
  0/758-Bedrock finding — each is a kill-shot the lab is *built to want*
  (epistemology §4: FAGAN attacks — does the claim survive).

## The dimension owned

**Falsification design.** PLATT owns the DESIGN step of the loop: between REGISTER
(a claimed belief on the spine) and SETTLE (the deterministic instrument runs),
he writes the **crucial experiment + its pre-registered bar** — the
`resolution_criterion` the forecast carries and the verdict the settler will
compute against. Falsification is the lab's product; PLATT is the author of the
thing that can do the killing.

## Maps to BUILT primitives

> Evidence (read, cited) vs aspiration is marked per line.

- **The pre-registered bar → `src/research/schemas/tetlock-forecast.ts` ::
  `TetlockForecast.resolution_criterion` (EVIDENCE).** The built schema documents
  this field as "Pre-registered resolution criterion (PLATT's crucial-experiment
  bar) — the deterministic test that will settle the bet." PLATT writes it;
  TETLOCK carries it; the settler computes against it.
- **The kill outcome → `ForecastOutcome` in the same file (EVIDENCE).** The
  resolution type is `"held" | "falsified" | "insufficient"` — `falsified` is a
  first-class outcome in the type system itself, not an error case. A kill has a
  name in the schema.
- **The DESIGN step has no LLM in it → grounding gate + provider honesty in
  `src/research/probe.ts` (EVIDENCE, by exclusion).** PLATT's deterministic-only
  discipline is what the probe already enforces upstream of design: a finding is
  `claimed` only if it passes `validateCitations()` (linkrot / circular /
  freshness / confidence — Contract D), and a finding served by the wrong provider
  is `routing_fallback` via `isRoutingFallback()` / `assertProviderResolved()`
  (Contract B), never counted as evidence. The probe will not hand PLATT a
  fabricated premise to design against.
- **The SETTLE is deterministic, NEVER an LLM (EVIDENCE for the boundary;
  ASPIRATION for live settlers).** The settle instruments are on-chain reads,
  tests, and market P&L. The on-chain settler exists as a built, cost-capped
  sensor — `src/research/sensors/dune.ts` (`makeDuneSensor`): it shells the
  Asson-graduated `dune-meter` CLI with a MANDATORY `--cap`, returns
  `inference_micro: 0n` and `provider_intended: "dune"` (DATA, not inference), and
  raises a typed `ResearchSensorError` on refuse / cap-abort rather than
  fabricating a result. There is no LLM in this path — exactly PLATT's bar. (Note:
  in V1 the dune CLI is an Asson scaffold — `duneAvailability()` is
  typed-unavailable until `DUNE_METER_BIN` points at the binary; the *settle
  shape* is built, the live wiring is V2.)

## V1 scope (spec §F — human-orchestrated)

This is a **brief, not a construct manifest**. The DESIGN step is run by the
**human / main-loop orchestrator** per the manual handoff in
`grimoires/loa/lab/METHODOLOGY.md`: the operator (or the main agent acting as the
desk) writes the crucial experiment and its pre-registered bar before the settle
runs. Stub `construct.yaml` manifests are a V2 graduation. **On-deck desks**
(named, not built in V1): Commerce / Distribution (Coinbase / Base / x402
archetype) and Craft-Velocity (Linear / Ramp archetype); **DUGAN** (program
direction, Pasteur's quadrant) and **POPPER** (falsification floor, already
embodied by the epistemology) remain on-deck.

## The boundary (k-hole lens)

PLATT designs the test; he does not run it and he does not score it. The settle is
a deterministic instrument (epistemology §4: *models never settle verdicts*) and
the calibration is TETLOCK's. The whole point of the Kill Switch is that the
killing is mechanical — a bar pinned before the run and a deterministic outcome
checked against it — so that no agent, PLATT included, can argue a hypothesis back
to life.
