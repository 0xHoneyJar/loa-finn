# src/cabt — Kaggle PTCG (cabt) Simulation agent

A determinized-search agent for the Pokémon TCG AI Battle Challenge (Simulation category).
**First baseline submitted 2026-06-18** (PIMC floor, ref 53791925). Design + ground truth:
`grimoires/loa/{prd-cabt,sdd-cabt}.md` + `grimoires/loa/context/2026-06-17-phase0-cabt-abi-cert.md`.

## What's here
| File | Role |
|---|---|
| `agent.py` | submission entry `agent(obs_dict) -> list[int]`; deck-as-first-action; chess-clock-budgeted; never crashes a match |
| `policy.py` | `pimc_select` — determinized 1-ply PIMC over the engine's search API (the move engine) |
| `search.py` | `predict_opponent` (mirror-deck determinization) + lazy `cg.api` loader |
| `augury.py` | `position_value` — prize-differential value (HP bounded below one prize) |
| `main.py` | bundle entry: `from cabt.agent import agent` |

## The engine (`cg/`) and data are competition-provided, NOT vendored here
The cabt engine is Linux x86-64 only (`libcg.so`) and ships in the competition `sample_submission/cg/`.
Download with the Kaggle CLI (auth required):
```
kaggle competitions download -c pokemon-tcg-ai-battle -f sample_submission/cg/api.py   # + game/sim/utils/__init__/libcg.so/cg.dll
kaggle competitions download -c pokemon-tcg-ai-battle -f sample_submission/deck.csv
kaggle competitions download -c pokemon-tcg-ai-battle -f EN_Card_Data.csv               # card DB (Sprint-2 augury)
```
Import path at match time is **`from cg.api import search_begin, search_step, to_observation_class, ...`**.

## Build + validate + submit
The engine is Linux-only, so build/validate run in a `linux/amd64` container:
```
# assemble bundle: main.py + cabt/ + cg/ + deck.csv  ->  submission.tar.gz
# validate (plays a full match as Kaggle would):
docker run --rm --platform linux/amd64 -v <bundle>:/bundle:ro python:3.12-slim \
  bash -lc "cd /bundle && python -c 'import main'"
kaggle competitions submit -c pokemon-tcg-ai-battle -f submission.tar.gz -m "..."
```

## Status (Sprint 1 floor) + what's next
- **Done:** legal full matches, beats random, 3-model-reviewed + hardened (chess-clock budget, disjoint+sized
  determinization, bounded HP value, leak-safe search lifecycle). First leaderboard entry submitted.
- **Sprint 2 (deferred, flatline-flagged):** card-aware augury from `EN_Card_Data.csv` / `all_card_data()`;
  multi-select + `minCount=0` decisions (#6/#8); a real win-rate eval (N matches + SPRT, not 2/2-vs-random);
  the persistent Linux worker; deeper ISMCTS (tree + rollouts) over the same `search_begin`/`search_step`.
