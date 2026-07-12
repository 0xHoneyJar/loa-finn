---
status: candidate
created: 2026-06-14
cycle: cycle-053
author: Finn (main-loop)
hivemind:
  schema_version: "1.0"
  artifact_type: product-spec
  product_area: "loa-finn — the lab as a gadget factory (research → small modules → keep/sell/throw)"
  workstream: experimentation
  priority: high
  jtbd: {category: functional, description: "turn the realness-filter research into small, consumable, falsifiable modules — and decide which one is worth formalizing into a build"}
  learning_status: directionally-correct
  source: team-internal
scope_note: "CANDIDATE crystallization brief — the pre-/plan artifact (doctrine: /plan is the END of exploration). NOT active doctrine, NOT a plan. It frames the gadget-factory direction + the cron/sandbox automation so /plan-and-analyze has a sharp input. Promote only on explicit operator approval. Grounds in 3 completed settles + GADGET #001 (built+tested this session)."
---

# Brief — Finn's shop: the lab as a gadget factory

> Finn (Neuromancer): not a scientist — a **fence who appraises and deals**. The lab
> doesn't publish papers; it grinds small verified instruments from research, tests
> them against reality, and **keeps, sells, or throws** each one. The realness filter
> is the loupe. Every gadget is a different lens ground from the same glass.

## The frame (operator, 2026-06-14)

*"Think of this as a lab where we make small gadgets, test them out, throw them away,
or sell them … small modules consumed by real products."* Plus: realness ≠ survival;
a cron + sandboxes to keep research current.

## Where we are (grounded — read, not claimed)

- The realness filter is **validated as an instrument** (`SETTLES.md` 001/002/003):
  it returns THEATER for x402 (99.3% self-dealing, shrinking) and REAL for Kintara
  $KINS (29k traders, top-1 5.78%, growing). "It only ever says fake" is falsified.
- **GADGET #001 already exists** (`grimoires/loa/lab/gadgets/realness-verdict/`): the
  SETTLE verdict as a pure, tested module — reproduces both verdicts from one
  instrument. Built + 5/5 green this session. Status: KEEP (the kernel).
- Eileen's macro research corroborates the negative: the *agent economy* (x402 /
  Virtuals / aGDP) is subsidy-fed theater, decaying. **Real on-chain economies exist
  — they look like Kintara (a game/app + a token with broad, distributed, growing
  demand), not like agent-commerce.**

## The pushback (lead with the doubt)

**"Sell gadgets" is the seductive answer and the wrong first move.** Anyone with a
Dune key can compute a realness score *once*. The score is a commodity. What is *not*
a commodity — what is the actual franchise — is the **calibration track record**: a
ledger of pre-registered, deterministically-settled, Brier-scored bets that says *"we
called 50 of these, here's how often we were right, here's the on-chain receipt."*
That is the appraiser's reputation, and it is the only thing in this stack that
compounds and can't be copied in a weekend. **Don't sell the loupe. Sell the
reputation of the appraiser who's been right.** So the first build is not a
score-API; it's the **engine that grows the track record** — the cron'd loop.

## The gadget line (JOBS — what's worth running)

| # | Gadget | What it is | Tag |
|---|---|---|---|
| 001 | **realness-verdict** | SETTLE math as a pure module (BUILT) | KEEP — kernel |
| 002 | **survival-forecaster** | first-N-days shape → P(survive 30d); realness ≠ survival | KEEP→SELL |
| 003 | **realness-score svc** | token/contract → metered grounded verdict (Artemis/Allium charge for this) | SELL (later) |
| 004 | **firehose-cron** | WEBB autonomous: scan X → probe → settle → post a daily "what's real in the trenches" | SELL/THROW (content) |
| 005 | **calibration-ledger** | Brier track record as ERC-8004 attestation — THE MOAT | KEEP — franchise |

**The one worth formalizing first: the automation that produces #005's corpus.**
Everything else is downstream of having a long, honest, scored track record.

## The automation (the cron/sandbox design)

`realness ≠ survival` is not a caveat — it's the **product spec for the loop's
second pass.** A one-shot settle measures the present; survival needs the *same bet
re-settled over time*. So:

```
  cron (daily/weekly, in a cost-capped sandbox)
   ├─ WEBB: grok firehose → candidate tokens/economies (SIGINT-WIRING.md)
   ├─ for each NEW candidate: run lab-cycle (PROBE→…→SETTLE→CALIBRATE)
   └─ for each PRIOR REAL verdict: RE-SETTLE on schedule (t+7, +30, +90)
        → did the distributed demand survive the first drawdown?
        → each re-settle is a labeled datapoint for #002 + a Brier update for #005
```

**Hard dependency, surfaced:** a headless cron **cannot** use the Dune MCP (it's
interactively authenticated — absent in headless/cron runs). So the automation
*requires the governed `dune-meter` path fixed* (key-based, cost-capped,
execute-by-id) — the thing all three settles had to route around. **The cron
directional promotes the dune-meter fix from "someday" to "blocking dependency #1."**
This is the concrete, grounded reason to do it, and the dropped-call double-charge in
SETTLE-003 is the second.

Run it through `/compose` on `lab-cycle` (governed runtime), NOT hand-runs — the
whole point of automation is that it forces the discipline a one-off appraisal can
skip. Sandbox = isolation + a hard credit cap per run (the dune-meter `--cap`).

## Open forks for the operator (before /plan-and-analyze)

1. **First build target:** the corpus-engine (cron + dune-meter fix), or a sellable
   gadget (#002/#003)? This brief argues corpus-engine first.
2. **Sandbox substrate:** Railway (the cost-of-play deploy lineage) / headless-tmux
   (lab-cycle's backend) / the Loa run-mode + /schedule cloud agents — which is "our
   sandboxes"?
3. **Sell-or-keep posture:** is the near-term goal external revenue (package #003),
   or internal edge (the track record steers what THJ builds)? Changes everything
   downstream.

## Read next
- `grimoires/loa/lab/SETTLES.md` — the 3 settles that ground this
- `grimoires/loa/lab/gadgets/realness-verdict/` — GADGET #001 (the factory, proven)
- `grimoires/loa/lab/SIGINT-WIRING.md` — WEBB's firehose (cron input)
- `grimoires/loa/lab/COMPOSITION.md` — the loop as a governed composition (cron engine)
