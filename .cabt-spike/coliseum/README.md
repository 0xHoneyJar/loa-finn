# The Coliseum — a live round-robin arena for cabt agents

A repeatable tournament harness: every entrant plays every other, seat-swapped, in the **real
`cg` engine** (the same engine the Kaggle ladder uses). Output is a Bradley-Terry **Elo
leaderboard** + win-matrix + a **field-trust meter** + a results JSON. There's a `--replay`
**ride-along** ("simstim") mode that prints a per-decision trace of one match so you can watch
an agent think.

It exists to solve the **pacing problem**: we get 5 ladder submissions/day and we've been
*burning* them to learn things a trustworthy local field would tell us for free. The coliseum
is that local field — pre-screen a bet here before spending a submission.

## ⚠ The load-bearing caveat (read this)

A coliseum is a **local proxy**, never the ladder. **GAMES-014 proved** that a field made of our
own variants + imitation clones **cannot reproduce the ladder** (it mis-ranks v4/v5/v6 and a weak
clone can top the board). So the field-trust meter will read **SYNTHETIC** and tell you *not to
trust the fine ranking* until **real, diverse teammate agents** enter. That is the whole point of
the "with our internal team" framing: the instrument earns trust in proportion to how real its
field is. Clones are flagged `⚠spar` — sparring partners, not the field.

(First run, N=2, 8 internal entrants: it ranked `champion-dwebble` #1 — matching the ladder's PB
807.5 — but mis-ranked v5 above v4 and put a clone at #2. The deck lever is so large it survives a
weak field; the pilot ranking does not. Exactly what the meter warns.)

## Run it

The `cg` engine is Linux-only, so run in the amd64 container (engine + decks live under `.cabt-spike/`):

```bash
# full tournament (N matches per matchup PER SEAT; total = 2N/matchup)
docker run --rm --platform linux/amd64 -v "$PWD:/app" -w /app python:3.12 \
  bash -c "python .cabt-spike/coliseum/coliseum.py --n 8"

# ride-along (simstim): watch ONE match decision-by-decision
docker run --rm --platform linux/amd64 -v "$PWD:/app" -w /app python:3.12 \
  bash -c "python .cabt-spike/coliseum/coliseum.py --replay champion-dwebble v5-abomasnow"
```

Flags: `--roster <path>` (default `.cabt-spike/coliseum/roster.json`), `--n` (matches/seat,
default 4), `--replay A B`, `--out <results.json>`.

## How a teammate enters (the intake)

An entrant is `(pilot, deck)`. A teammate's agent is just a **Kaggle-shaped bundle**: a directory
with `main.py` (or `agent.py`) exposing `agent(obs) -> list[int]` and a `deck.csv`. To enter:

1. Drop the bundle somewhere in the repo, e.g. `.cabt-spike/coliseum/bundles/alice/`.
2. Add a line to `roster.json`:
   ```json
   {"name": "alice-aggro", "owner": "alice", "pilot": "bundle:.cabt-spike/coliseum/bundles/alice", "deck": ".cabt-spike/coliseum/bundles/alice/deck.csv"}
   ```
3. Re-run. `owner` ≠ `internal`/`lab` counts as a **real** entrant; the field-trust meter promotes
   `SYNTHETIC → BOOTSTRAP → TRUSTWORTHY` as ≥3 distinct real owners join.

Built-in pilots you can reference by name: `v4`, `v5`, `v6` (our heuristics), `greedy` (the floor),
`clone:dwebble_crustle|lucario|alakazam` (sparring imitators).

## What it does NOT do (yet)

- No SPRT / early-stopping — it runs a fixed N. For a real bet-screen, use `--n 16`+ and read the
  win-matrix CIs by eye (Wilson math is in the older `container_arena.py` if you want it ported).
- The Elo is a single-shot Bradley-Terry fit with Laplace smoothing, not a confidence-rated rating.
- It's a spike instrument living next to its engine deps under `.cabt-spike/`. If it earns its keep
  (i.e. real teammate agents make it trustworthy), promote it to a first-class home + a `/coliseum`
  skill.

## Files

- `coliseum.py` — the runner (round-robin · Elo · matrix · trust meter · replay).
- `roster.json` — the field. Edit this to add entrants.
- `results-<ts>.json` — per-run output (Elo, wins, games, field-trust).
