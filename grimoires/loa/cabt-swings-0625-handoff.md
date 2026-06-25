# cabt — Two Big Swings: submit handoff (2026-06-25)

Built, pre-screened, and **pre-registered (logged before outcome)**. Kaggle creds are absent in-session, so
**you submit**. The calibration discipline holds only if the pre-registration is **git-committed before you submit**
(git precedence is the trust root). See the commit step below.

## The two swings to submit → `pokemon-tcg-ai-battle` (5 subs/day)

| # | Swing | Bundle | Forecast id | p | Why |
|---|-------|--------|-------------|---|-----|
| 1 | **MIRROR** | `.cabt-spike/submission-hammer-v4.tar.gz` | `cleanse-enhanced-hammer-v4-mirror` | **0.40** | cleanse −2 Basic{G} +2 Enhanced Hammer[1081], v4. Strips the 65%-mirror's 12 special energies. **Pre-screen rank #2** (beats the wall 0.56 + the cleanse PB deck 0.56). |
| 2 | **STRUCTURAL** | `.cabt-spike/submission-alakazam-v8.tar.gz` | `deck-alakazam-v8-powerful-hand` | **0.20** | The field's apex deck (60.3% WR, beats Crustle 80%) + our new v8 "Powerful Hand" pilot (FAGAN-converged version). The counter-meta break. **Long shot** but functional — beats cleanse PB deck h2h and now **clears the kill-gate vs the Crustle wall (0.56)** after the FAGAN fix. |

**Do NOT submit `submission-boss-v7.tar.gz`** — it was the pre-registered mirror bet (`cleanse-boss-orders-v7-mirror`,
p=0.40) but **pre-screened do-harm** (rank #7, 0.19 vs the Crustle wall; gygax's v7-hand-dumping warning confirmed twice).
Its forecast stays **logged + unresolved** (the pre-screen caught it before it cost a ladder slot — that is its job).

## Submit steps (Kaggle UI or CLI)

The bundle IS the Kaggle submission (`./main.py` + `./deck.csv` + `./cabt/` + `./cg/`). Either:
- **UI:** upload the `.tar.gz` to the competition's submission page, OR
- **CLI (needs `~/.kaggle/kaggle.json`):** `kaggle competitions submit -c pokemon-tcg-ai-battle -f .cabt-spike/submission-hammer-v4.tar.gz -m "mirror: cleanse+EnhancedHammer+v4 (p=0.40)"` (repeat for alakazam-v8).

## After the ladder scores settle — resolve each forecast

```
# from repo root, once you have the ladder Elo for each submission:
resolveRegisteredDecision("<id>", {instrument:"ladder-measured", ground_truth:"<note + scores>"}, <observedMarginPpm>)
# (the resolver appends the scored record + Brier to cabt-calibration-logged.jsonl)
```
Baseline to beat = the reigning **cleanse PB** (~956 contemporaneous / 986 peak). Then read the **PATTERN**: if Hammer
holds and Alakazam-v8 fails → the 986→ lever is **mirror-tech**, keep climbing Crustle. If Alakazam-v8 lands → the meta
tipped, **the structural counter-meta break is live** (re-pilot Alakazam harder). If both flat → the residual is off-deck.

## Commit before you submit (the trust root)

The pre-registration is on disk but not yet git-witnessed. Commit the calibration record so "logged before outcome"
is provable:
```
git add src/research/cabt-pre-register.ts grimoires/loa/lab/cabt-forecasts.jsonl grimoires/loa/NOTES.md \
        grimoires/loa/cabt-swings-0625-handoff.md
git commit   # message: "chore(cabt): pre-register two big swings (mirror Hammer + structural Alakazam-v8)"
```
(Branch `lab/custodian-thompson-roster-brief` — safe, not main.)

## Environment flags (operator action)

- **Disk hit 100%** mid-session (118Mi free) → **Docker Desktop crashed**; relaunched, recovered to ~4Gi. **Docker.raw is
  60GB** — run `docker system prune` / trim caches before the next Docker-heavy pre-screen, or it will crash again.
- **Meta-drift re-poll** (frozen-probe sense) needs Kaggle creds — run `coliseum/meta_observatory.py` on your side to
  refresh the live ladder scores (cleanse was drifting 986→956).

## The `/compose` run + a real bug it caught

The v8 pilot was authored through `/compose code-implement-and-review` (implement ↔ FAGAN, **converged in 3
iterations, APPROVED**). FAGAN caught a bug my own review missed: **`cards.py` has no public `card()` accessor**, so
the spec's `cards.card(id).name` — which the first-built v8 used — was dead (NAME detection silently no-op'd). The
converged v8 (shipped in the bundle) reads the loaded `cards._CARDS` global read-only instead → Rare-Candy + Stage-2
detection are **live**, and the re-pre-screen WR vs the Crustle wall rose 0.44 → 0.56. (The formal `valid_run` custody
stamp wasn't captured during the run; I did not forge it post-hoc — the Legba gate correctly refuses a hand-injected
envelope. The convergence is real per the workflow's own completion record.)

**Latent v7 bug (flagged, not fixed — out of this scope):** `heuristic_v7._hand_card_name` (line 144) routes through
the same non-existent `cards.card` → returns "" → **v7's draw/search-word sequencing is dead** (it can't tell a draw
trainer from a develop). This partly explains why boss-v7 pre-screened do-harm. **Follow-up:** add a public read-only
`card_name(id)` to `cards.py`, then point both v7 and v8 at it (drop v8's private-global reach). This could also
materially improve v7 / boss-v7.

## On-deck (next session)

- A **higher-N / real-field** pre-screen would firm the Hammer>Boss + Alakazam-v8 reads (all within-noise at N=8,
  SYNTHETIC field — GAMES-014 says it can't reproduce the ladder; it only kills collapses).
- If Alakazam-v8 lands even partially, **v8.1**: encode the Stage-2 setup secondaries (Rare Candy sequencing, energy
  curve) gygax flagged — the part the current hand-size rule doesn't fully reach. That's where the rest of the
  0.56→0.80 ceiling lives.
- Fix the v7 `cards.card` bug (above) — cheap, and it un-degrades every v7-piloted bet.
