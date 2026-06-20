# Architecture: a party of constructs running a learning loop

> Reference shape only. You have no obligation to any name, field, or boundary here.
> Re-derive each against your own substrate.

This document describes one coherent architecture for an LLM-driven strategic agent
that has to win a game where **the opponent adapts**. The central claim is that there
is no static winning team — any fixed strategy gets read and countered — so the unit of
design is not a roster but a **metabolism**: a loop that plays, learns, counters,
re-rates, and repeats. The constructs are the organs of that loop.

---

## 0. The mismatch this resolves

Three jobs get conflated constantly. Keep them apart and most confusion dissolves:

- **Playing** the game well (sequential decisions under hidden information).
- **Choosing** what to field against an adaptive field (population-level strategy).
- **Ranking** the players/policies themselves (skill estimation from noisy outcomes).

Different tools own each. Search owns playing. PSRO/bandits own choosing. Elo/TrueSkill
owns ranking. An LLM can occupy any of these seats, but **the LLM does not change the
math** — it is the policy you slot in, or the player you score. The strategic spine is
classical multi-agent RL.

---

## 1. The design law (binding name to capability)

A construct = **coarse pointer** (a name/archetype that activates a region of the
model's latent space) **+ focusing spec** (a capability description precise enough to
be *verified*). Resolution is the product of the two.

- Name alone → a broad, high-entropy basin. Famous names drift to caricature; that
  drift is where you fool yourself.
- Each concrete, checkable capability term is a *conditioning constraint* that carves
  probability mass away from everything that doesn't satisfy it. **Specificity is
  denoising.** The sharpest cut is a named operation the model cannot satisfy with a
  plausible-sounding gesture — because you can check it.
- Therefore: name to point, specify to focus, **verify to bind**. A construct is
  exactly as real as the operation you can name and check.

This is why naming and capability must move in lockstep. A name pointing at a
capability it cannot ground is the canonical failure — the one a grounding/enforcement
layer exists to catch.

---

## 2. The organs

Each organ is stated as: *pointer · operation · where the ML lives · the check that
binds it.* The "check" column is the most important — it is what makes the organ real
rather than narrated.

### The Hand — plays one match
- **Operation:** given a game state under hidden information, produce a strong move.
- **ML:** search. MCTS where state is fully observed; CFR / R-NaD / belief-state search
  where it is not (the poker-and-Stratego lineage).
- **Check:** moves are legal; rollouts reproduce the reported value within tolerance;
  the played line matches the committed line (no narrate-one-thing-play-another).

### The Augur — reads the opponent, decides where to look
- **Operation:** maintain a belief over opponent type; choose which matchups to spend
  simulation budget probing next.
- **ML:** Bayesian opponent-modeling + **Thompson Sampling over matrix cells** (this is
  where TS actually lives — exploration over *which matchups to simulate*, not over
  which team to bring).
- **Check:** posterior updates are conjugate/consistent with observed outcomes; sampled
  exploration targets are the high-uncertainty, decision-relevant cells, not arbitrary.

### The Cartographer — solves the matrix into a mixed strategy
- **Operation:** take the (partially filled) matchup matrix and return a *distribution*
  over strategies that is hard to exploit.
- **ML:** the meta-solver. Zero-sum LP (minimax), replicator dynamics, regret
  minimization → Nash / correlated equilibrium.
- **Check:** the returned mixture's worst-case value matches the solver's claimed game
  value within tolerance; the mixture is a valid probability vector; no pure strategy in
  support has a strictly dominating counter already present in the matrix.
- **This is the worked example in `prompts/cartographer.claude.md`** because "minimax
  over a payoff matrix" is a *fully* verifiable operation.

### The Oracle — forges a counter to the current mix
- **Operation:** freeze the Cartographer's mixture; produce a *new* strategy that best-
  responds to it (the PSRO growth step).
- **ML:** an RL or search step — train/optimize a policy against the frozen mixture.
- **Check:** the new strategy's win-rate vs. the frozen mixture exceeds the mixture's
  own game value by a margin (it genuinely beats the meta); it is novel relative to the
  Archivist's population (not a duplicate).

### The Loyal Traitor — measures how beatable you are
- **Operation:** same forge as the Oracle, opposite purpose: find the worst-case exploit
  against your *current* mixture, to **measure exploitability**, not to add to the team.
- **ML:** exploiter best-response (cf. AlphaStar's "main/league exploiters").
- **Check:** reported exploitability is reproducible by re-running the exploiter; if it
  exceeds threshold, the loop is *not* allowed to declare convergence.

### The Archivist — never forgets
- **Operation:** persist every strategy ever fielded so the system cannot cycle into
  amnesia (rock→scissors→paper→rock forever).
- **ML:** the strategy population; fictitious-play memory.
- **Check:** population is append-only and content-addressed; re-deriving any historical
  matchup yields the stored win-rate within tolerance.

### The Adjudicator — calibrated skill, "are we improving?"
- **Operation:** turn noisy win/loss into a calibrated skill estimate across the
  population, and answer the only cross-loop question that matters: is the needle moving
  or are we chasing our tail?
- **ML:** Elo / TrueSkill / Bradley–Terry.
- **Check:** ratings are computed only from *custody-stamped* matches (see Custodian);
  predicted matchup probabilities are calibrated against held-out outcomes.

### The Custodian — proves the match was real
- **Operation:** guarantee that a match was played under the stated rules, with the
  stated strategy, and emit a verifiable receipt. Fail-closed.
- **ML:** none — this is your enforcement/custody layer (e.g. an external lattice like
  loa-laplas). It is the *referee and the match-record*, not a strategist.
- **Check:** every result feeding the Adjudicator carries a receipt that an independent
  verifier re-checks; an unstamped or non-verifying result is refused, not averaged in.
- **Boundary note:** in *your* system this is real infrastructure you already own. The
  reference toy fakes it with a hash-chain so the *shape* is visible; do not mistake the
  toy's `verify.py` for custody.

---

## 3. The loop (the leader's instrument)

```
            ┌──────────────────────────────────────────────────────────┐
            │                      THE LEADER (you)                      │
            │           loop · ship · rest   (explore vs exploit)        │
            └───────────────┬──────────────────────────────────────────┘
                            │ sets tempo
        ┌───────────────────▼───────────────────┐
        │                                        │
   ┌────▼─────┐   plays    ┌──────────┐  fills  ┌▼───────────┐ solves ┌──────────────┐
   │  HAND    ├───matches──►│  AUGUR   ├──cells──►│ ARCHIVIST  ├─matrix─►│ CARTOGRAPHER │
   │ (search) │            │ (beliefs │         │(population)│        │ (meta-solver)│
   └──────────┘            │  + TS)   │         └─────▲──────┘        └──────┬───────┘
        ▲                  └──────────┘               │ adds                 │ mixture
        │                                             │                      │
        │ new strategy joins                    ┌─────┴──────┐        ┌──────▼───────┐
        └───────────────────────────────────────┤   ORACLE   │◄───────┤  (freeze the │
                                                 │(best-resp.)│        │   mixture)   │
                                                 └────────────┘        └──────┬───────┘
                                                                              │ also audited by
                              ┌───────────────┐   stamps    ┌──────────────┐  │
                              │   CUSTODIAN    │◄──every─────┤ LOYAL TRAITOR│◄─┘
                              │ (receipts,     │   match     │ (exploiter → │
                              │  fail-closed)  │             │ exploitability)
                              └───────┬────────┘             └──────────────┘
                                      │ stamped results only
                                ┌─────▼──────┐
                                │ ADJUDICATOR│  "are we improving?"  →  back to LEADER
                                │(Elo/TrueSk.)│
                                └────────────┘
```

**One turn of the metabolism:**
1. **Hand** plays matches drawn from the current mixture.
2. **Augur** updates beliefs and picks the next matchups to simulate (Thompson over cells).
3. **Archivist** records every fielded strategy and matchup outcome.
4. **Cartographer** solves the matrix → a mixed strategy.
5. **Oracle** freezes the mixture, forges a best-response, hands it to the Archivist.
6. **Loyal Traitor** attacks the same mixture to measure exploitability.
7. **Custodian** stamps every match; **Adjudicator** re-rates using only stamped results.
8. **Leader** reads exploitability + rating trend and decides **loop / ship / rest**.

The art is in step 8. Most of leadership is *restraint*: knowing which organ is hungry
and feeding only that one. Stop forging when the Loyal Traitor can't find an exploit and
the Adjudicator says the trend has plateaued — otherwise you are burning compute to chase
your own tail.

---

## 4. Data shapes (placeholders — re-derive against your own schemas)

These are illustrative JSON shapes to make the interfaces concrete. They are **not** a
schema to adopt; they show *what kind of thing* crosses each boundary.

```jsonc
// A strategy in the Archivist's population (content-addressed).
{
  "id": "strat:7f3a…",          // hash of the spec; stable name
  "pointer": "aggro-tempo",     // human-coarse label
  "spec": { /* whatever your Hand needs to instantiate play */ },
  "born_at_iter": 4,            // which loop turn forged it
  "forged_by": "oracle"         // or "seed" | "loyal_traitor" (audit only)
}

// A match result the Custodian stamps and the Adjudicator consumes.
{
  "a": "strat:7f3a…",
  "b": "strat:91c0…",
  "n_games": 200,
  "wins_a": 118,
  "receipt": "ed25519:…|chain:…",   // YOUR custody artifact; toy uses a hash chain
  "verified": true                  // an INDEPENDENT verifier set this, not the player
}

// The Cartographer's output.
{
  "support": ["strat:7f3a…", "strat:91c0…", "strat:aa12…"],
  "mixture": [0.41, 0.35, 0.24],    // valid probability vector
  "game_value": 0.0,                // zero-sum: ~0 at equilibrium
  "claim": "no present pure strategy strictly dominates this mixture"
}

// The convergence signal the Leader reads.
{
  "exploitability": 0.018,          // Loyal Traitor's best margin vs current mixture
  "rating_trend": "+3 over 5 iters",// Adjudicator
  "recommend": "rest"               // loop | ship | rest  (advisory; leader decides)
}
```

---

## 5. Where the classical methods sit (cheat-sheet)

| You want to… | Method | Lives in |
|---|---|---|
| play a hidden-info match | MCTS / CFR / R-NaD / belief search | Hand |
| decide which matchups to simulate | Thompson Sampling / UCB | Augur |
| solve who-beats-whom into a mix | minimax LP / replicator / regret-min | Cartographer |
| invent a counter to the meta | best-response RL/search (PSRO step) | Oracle |
| measure how exploitable you are | exploiter best-response | Loyal Traitor |
| avoid strategic amnesia | population memory / fictitious play | Archivist |
| rank policies from noisy wins | Elo / TrueSkill / Bradley–Terry | Adjudicator |
| trust any of the numbers | external custody, fail-closed | Custodian |

---

## 6. Failure modes (the honest section)

- **Narrated competence.** A construct says it did the operation; it didn't. Defense:
  every organ's *check* must be a diffable signal, not a self-report. This is the single
  most important discipline and the reason the Custodian and Adjudicator exist.
- **Caricature leak.** Under-specified pointers let the mythologized persona flood in
  (especially for famous names). Defense: bind a verifiable operation hard enough that
  the pointer contributes only flavor, never testimony. Never emit words *as* a real
  person claiming endorsement.
- **Self-play amnesia.** Without the Archivist you cycle forever. Defense: append-only
  population; always best-respond to a *solved mixture*, never to the single latest
  opponent.
- **False convergence.** "Nobody has beaten us yet" ≠ "we are unbeatable." Defense: the
  Loyal Traitor must actively fail to find an exploit before the Leader may declare done.
- **Custody theater.** A receipt the producer can forge is not custody. Defense: an
  *independent* verifier re-checks; in the toy this is `verify.py`, in your system it is
  real infrastructure.

---

## 7. What this is NOT

- Not a wiring diagram for your stack. No endpoints, no routing, no real custody.
- Not a claim that LLMs change the game theory. They occupy seats; the math is classical.
- Not a way to channel real people. A human name is a lossy pointer to a reasoning
  *style*; the capability spec does the real work and keeps the person non-load-bearing.
- Not production code. The `reference/` toy exists to be *watched*, then discarded.
