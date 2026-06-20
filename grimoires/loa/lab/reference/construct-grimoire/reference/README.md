# reference/ — the toy you run to *watch the words happen*

Pure Python, zero dependencies. ~250 lines across two files. This is the smallest honest
version of the whole loop. Its only job is to turn vocabulary into a thing you saw move.

> **Not your engine.** Every organ is faked with the simplest stand-in that's still
> *honest about its shape*. The game is a toy scalar zero-sum game; the custody is a hash
> chain, not real custody. Swap `evaluate()` for your real Hand and the loop is unchanged.
> Replace `verify.py`'s hash chain with your real Custodian and the discipline is unchanged.

## Run it

```bash
python3 psro_min.py                  # default: 10 iters, seed 1
python3 psro_min.py --iters 12 --seed 7
python3 verify.py run.json           # independent re-check of the claims
```

## What you'll see

```
iter  pop   game_value  exploitability  new_strategy
------------------------------------------------------------
   0    1     0.000000        0.666660  0.6870
   1    2    -0.000042        0.608685  1.0000
   2    3    -0.000047        0.000047  1.0000

[leader] exploitability below threshold at iter 2 — REST.
```

Read it as the metabolism turning:

- **`pop`** — the Archivist's population growing. It starts at 1 and grows by one counter
  per iteration as the Oracle forges best-responses.
- **`game_value`** — the Cartographer's solved value of the matchup matrix. Near 0 because
  the toy game is symmetric zero-sum (an equilibrium mixture earns ~0).
- **`exploitability`** — the Loyal Traitor's verdict: how much the best opponent response
  beats the current mixture. **This is the number that matters.** Watch it collapse toward
  0 — that *is* PSRO converging: the population has grown enough counters that no new
  strategy can cleanly exploit the mix.
- **`new_strategy`** — the Oracle's freshly forged best-response, about to join the
  population.
- **`[leader] … REST`** — the stopping rule firing. The Leader rests when the Traitor can
  no longer find an exploit. (Loop / ship / rest — the one decision no organ makes for you.)

## What `verify.py` proves

It re-derives the run's claims **without trusting them**, the same posture your real
Custodian + Adjudicator must take:

1. **chain integrity** — recomputes the hash chain from the recorded payloads; every
   receipt must match. (Custody *shape*.)
2. **mixture validity** — every reported mixture is a real probability vector.
3. **convergence** — exploitability actually improved and ended small.

Try corrupting `run.json` (change a mixture so it sums to 1.8, or edit a receipt) and
re-run `verify.py`: it fails closed with exit code 1 and refuses the run. *A failing check
is a refusal, not an average.* That single behavior is the soul of the whole design.

## The mapping back to the organs

| Code | Organ | In your system, this becomes… |
|---|---|---|
| `evaluate()` | **The Hand** | real play under hidden info: MCTS / CFR / belief search |
| `solve_zero_sum()` | **The Cartographer** | your meta-solver (and the CLI prompt's spec) |
| `best_response()` | **The Oracle** | a real RL/search training step against a frozen mixture |
| `exploitability()` | **The Loyal Traitor** | a real exploiter best-response |
| `population` list | **The Archivist** | a content-addressed, append-only strategy store |
| printed trend | **The Adjudicator** | Elo / TrueSkill / Bradley–Terry over stamped matches |
| `chain()` / `verify.py` | **The Custodian** | your actual enforcement + custody layer |
| the stopping rule | **The Leader (you)** | your explore/exploit policy over the population |

## Why this game?

The toy kernel `sin(2.5·Δ)·exp(−1.5·Δ²)` is antisymmetric (so the game is genuinely
zero-sum, `evaluate(a,b) == −evaluate(b,a)`) and has an interior structure where any
single pure strategy is exploitable — which forces PSRO to build a *mixture* rather than
settle on one answer. That's the whole point: it reproduces, in miniature, the reason the
honest answer to "what should I field against an adaptive opponent" is a distribution.

## Things to try

- `--seed` changes only the initial strategy; convergence is robust to it.
- Bump `--iters` and watch exploitability sit near 0 once converged (the population is
  saturated — more forging is wasted compute, which is the Leader's cue to rest).
- Replace `evaluate()` with a non-zero-sum or asymmetric kernel and watch the clean
  convergence story degrade — a useful lesson in why the theory's guarantees are
  load-bearing and not decorative.
