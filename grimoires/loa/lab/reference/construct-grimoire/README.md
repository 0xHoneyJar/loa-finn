# construct-grimoire (reference package)

A **reference design**, not an implementation drop-in. It encodes a way of thinking
about LLM-driven strategic agents as a *party of named constructs running a learning
loop*, and it gives you three artifacts to adapt:

1. **`prompts/cartographer.claude.md`** — a prompt you can issue to `claude` (the CLI),
   written as a self-contained construct sheet. It is the worked example of the design
   law: *name to point, specify to focus, verify to bind.*
2. **`docs/ARCHITECTURE.md`** — the architectural overview: the organs, the loop, the
   data shapes, and where each classical ML/RL method actually lives.
3. **`reference/`** — a small, runnable PSRO ("double-oracle") toy in pure Python, plus
   a verifier. ~250 lines. Its job is to make the words *something you watched happen*,
   not to be your production engine.

## The one boundary that matters

> This package has **no awareness of your actual systems** — your model endpoints,
> your enforcement lattice, your custody chain, your routing. Everything here is a
> *shape* and a *law*, never a wiring diagram. Treat every filename, schema field, and
> function as a placeholder you re-derive against your own substrate. Where this package
> says "the verifier," you have your own referee; where it says "the oracle step," you
> have your own training/search budget. **Adapt, don't paste.**

## The design law (the whole thing in one breath)

A construct is a *coarse human/role pointer* focused by a *capability spec precise
enough to be verified*. Its resolution is exactly the verifiability of that spec.
The person (or archetype) is the **prior**; the capability is the **constraint**; the
check is the **proof**. Everything you can't name and check is the legend leaking back in.

## The party, in one line each

| Construct | Real function | Where the ML lives |
|---|---|---|
| **The Hand** | plays one match well under hidden info | search: MCTS / CFR / belief-state |
| **The Augur** | models the opponent; decides where to look | Bayesian opponent-modeling + bandit budget (Thompson) |
| **The Cartographer** | solves the matchup matrix into a *mixed strategy* | meta-solver: minimax LP / replicator / regret-min |
| **The Oracle** | forges a new strategy that beats the current mix | PSRO best-response (an RL/search step) |
| **The Loyal Traitor** | hunts the worst-case exploit to *measure* your beatability | exploiter best-response (audit, not addition) |
| **The Archivist** | never forgets a fielded strategy | the population itself; fictitious-play memory |
| **The Adjudicator** | turns noisy wins into calibrated skill; says "are we improving?" | Elo / TrueSkill / Bradley–Terry |
| **The Custodian** | proves the match was real; fail-closed | your enforcement/custody layer (e.g. loa-laplas) |

The **leader** (you) is the heartbeat: the one decision no construct makes for you —
**loop, ship, or rest** (explore vs. exploit at the population level).

## Layout

```
construct-grimoire/
├── README.md                      ← you are here
├── docs/
│   └── ARCHITECTURE.md            ← the organs, the loop, the data shapes
├── prompts/
│   └── cartographer.claude.md     ← the CLI prompt (worked construct sheet)
└── reference/
    ├── psro_min.py                ← runnable double-oracle toy (~250 lines)
    ├── verify.py                  ← independent check of a run's claims
    └── README.md                  ← how to run it, what to watch for
```

## Vocabulary, de-mystified

The six load-bearing ideas behind all of it (learn these, let the other forty terms
wash over you): **PSRO / double oracle** (grow a population of counters),
**meta-game** (the who-beats-whom matrix), **exploitability** (distance from
unbeatable), **autocurriculum** (the system generating its own escalating difficulty),
**population-based training**, **open-ended learning**.

License: do whatever helps. Attribution optional. Fidelity to your own systems mandatory.
