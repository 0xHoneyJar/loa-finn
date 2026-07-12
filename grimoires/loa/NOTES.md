# NOTES.md

## Session Continuity

### Session 2026-06-22 (ARCH+scar+ARTISAN) — Coliseum hardening: honest + fresh + fluid (all SHIPPED live)
Made the live coliseum board trustworthy without breaking the GAMES-014 honesty guard. Two FAGAN-gated
`code-implement-and-review` runs (both `valid_run`: df844da9, 79579cc7) + live Railway deploys.
- **The trap (closed):** relabeling owner lab→soju would have falsely flipped the meter SYNTHETIC→TRUSTWORTHY
  because `app.py:_recompute_field_trust` keyed `real` on owner-in-allowlist. Re-keyed on entrant KIND (pilot
  prefix + operator-owner exclusion) in BOTH twins (app.py + `coliseum.py:field_trust`, shared `_entrant_kind`).
  Only a DIVERSE EXTERNAL teammate (e.g. gumi) counts as real; our own soju agents never do. Test pins it.
- **Live board now honest:** `real=1` (gumi only — the broken meter counted our own *Soju Dash* → real=2), 0 `lab`
  owners, 26/26 `kind` coverage, BOOTSTRAP. An idempotent boot migration relabels + stamps the PERSISTED board
  (gumi's 14 rows byte-preserved). **Railway `/data` volume CONFIRMED persistent (1.1/48.8 GB) — staleness was
  never the volume; it was that WE never submitted our decks.** Submitted cleanse(#4)/v8(#6)/v4(#10) as soju.
- **UI shipped:** cabt-viewer leaderboard re-skin — rank-sorted, flip rank-transitions (reduced-motion aware),
  honest Wilson-CI bars (engine formula, real W–L), kind type-badges, 20s auto-refresh. Live at cabt-coliseum.
- **Follow-up:** `bd-zjrz` (stamp `kind` in `_register` so new submissions are born with it). Detail:
  `tracks/session-coliseum-hardening-kickoff.md`, `a2a/bug-20260622-e5b852/ops-findings.md`.

### Session 2026-06-20 (TEND) — Estate immune system: diagnose → cure (proven) → metabolism (fired)
Operator asked KEEPER to diagnose ecosystem cohesion friction, then to design an interval loop to drain backlogs.
- **Diagnosis (3-lens consilient):** KEEPER felt **"made, not landed"** (work pools at origin, never crosses the
  seam; every health check measures the origin bank); GECKO grounded it file:line; EULER cut to a single
  articulation node `X`. Brief: `context/2026-06-20-ecosystem-cohesion-diagnosis.md`.
- **Cure (PROVEN):** ran the 12-day-unrun `audit-ecosystem-coherence` composition via /compose →
  `valid_run` (run `20260620-ecocoh`, digest sha256:084f8c8c). It REFUTED the first X — real X = `~/.loa/deployment.yaml`
  exists but is **write-only/non-binding**. 6-step reversible **cutover teed up in `.run/compose/20260620-ecocoh/`**
  (operator runs — framework/runtime gated). Inert gates trace to the 578-commits-behind framework lag.
- **Metabolism loop (FIRED):** designed the **L2-PROPOSE relay** (stage the drain, operator ratifies — auto-apply
  forbidden by Ostrom/force-chain). Brief: `context/2026-06-20-estate-metabolism-loop-design.md`. Fired once:
  **8 clews drained** → `construct-minkowski#2` (worldline ×3) + `construct-kranz#11` (kranz ×5), marked `proposed`;
  **merge flips them `distilled`**. Backlog 29→21. protocol's 4 are homing-ambiguous (noether-authored, protocol-homed).
  PR-triage organ grounded in Hivemind Labs canon (close GHOST/archived only; label live-rotting; 14d UTC).
- **Open for operator:** merge the 2 clew PRs · run the X cutover · pick recurring mechanism (session-tick vs cron) ·
  resolve `claim-grade` (own skill vs `record` check) · confirm protocol clew homing.

### Session 2026-06-17 (DIG+ARCH) — Finn enters the Kaggle PTCG AI Battle Challenge (cabt)
Operator handed an AI blueprint (PufferLib+cabt+laplas+gaussian_ladder) + 4 repos; asked to CONTEST it and
get the mental models strong before building. Grounded + contested:
- **Verified real:** Kaggle PTCG AI Battle Challenge (Pokémon Co + HEROZ + Matsuo Institute; $300k+; Simulation
  closes **2026-08-17**, Strategy 09-14; 2000-card Standard; 10min/match). `cabt` = Matsuo engine
  (matsuoinstitute.github.io/cabt): `def agent(obs_dict)->list[int]`, 60-card deck CSV, `env.run`, **no reward
  signal**, legality intrinsic to `select.option`.
- **Blueprint contested (5):** enforcement-gate mostly redundant (cabt enforces legality); subprocess-per-step
  disk-JSON is the wrong shape; PufferLib ⊥ "loa picks the index" (it mashed the 2 categories); gaussian_ladder
  reinvents gygax's ladder+augury (+ Kaggle ranks officially); ignores stochastic imperfect-info (1 match≈noise).
- **Resolved model:** move engine = **ISMCTS** (NOT an LLM); gygax = augury priors + ladder/grader eval; arneson
  = diverse opponent population ("roleplay for judging"); laplas = poteau action-guard + ed25519 receipted record
  of agent-SYSTEMS; **loa-finn calibration = the promotion gate** (pre-register→seeded eval→Brier→promote); the
  research IS the competitive edge; cabt = a clean positive-control settle-instrument for the realness loop.
- **Operator decisions:** goal = compete to WIN; **Simulation category first**; **ISMCTS floor first**; heavy
  creative latitude granted.
- **Artifacts:** `context/2026-06-17-cabt-architecture-brief.md` (candidate) + `prd-cabt.md` (Draft — SIBLING to
  the Corpus-Engine `prd.md`, NOT superseding). Background dig running for D-1 (exact category rules / cabt
  seeding API / whether LLMs+internet allowed at match time / card-DB shape).
- **D-1 RESOLVED (dig, 2026-06-17):** Prize structure INVERTED — **Simulation has NO prize; ALL cash is in
  STRATEGY** ($30k×8 R1 + $50k/$30k finals + $3k GCP finalists; >$300k). Strategy = a written REPORT documenting
  the SAME agent you field in Simulation, judged on stability + deck-design concept + Sim performance → **Strategy
  is the PRIZE, Simulation the substrate; the calibration record IS the report's evidence.** cabt: **win/loss IS
  exposed** (`State.result`/`LogType.RESULT`) → PPO more viable than first stated; **NO RNG seed API** (randomness
  only via SHUFFLE/COIN logs → control variance by N, matches not reproducible); **deterministic forward-search
  API** `search_begin/step/end` (use for ISMCTS lookahead — don't reimplement the model); `all_card_data()`/
  `all_attack()` feed augury; 10-min = **chess-clock per player**; external pretrained models OK if cheap+
  accessible, **live LLM/internet at match time likely NO** → agent self-contained, FunSearch LLM is OFFLINE
  design-time; cabt is **closed-source** compiled `libcg.so`; 5 subs/day. **PRD updated → Rev 2.**
- **FunSearch speculative track written:** `context/2026-06-17-funsearch-edge-speculative.md` (candidate,
  background_only) — LLM authors agent-systems offline, cabt grades deterministically, calibration Brier-scores
  proposals; pre-registered kill-criterion H-FUNSEARCH; gated behind the ISMCTS floor.
- **/flatline-review DONE (2-model headless, 2026-06-17):** governed orchestrator (~/GitHub/loa) returned
  **degraded/empty** (opus down no ANTHROPIC + API-keyed gpt-5.5/gemini dead → 0 items, 0¢, the recurring finn
  dead-transport mode) → fell back to **direct codex + gemini CLIs** (own auth, work). Both sharp; CONVERGED on:
  **C1 BLOCKER determinization gap** (cabt `search_*` may forbid hidden-state injection → whole move-engine pivots;
  now FR-0 Phase-0 SPIKE gates FR-2), **C2 BLOCKER time-budget** (deep ISMCTS times out under the 10-15s/turn
  chess-clock → shallow search + augury value + per-turn abort), C3 calibration-variance under no-seed (p≥0.80 +
  fast eval clock + parallel + locked meta deck to isolate signal), C4 opponent-pool overfit (strong heuristic
  archetype bots first, personas as diversity layer). + codex caught a **self-contradiction I introduced** (CRN
  required while NFR-1 says no seed — fixed). 10 findings total, ALL folded → **prd-cabt.md Rev 3**. Consensus:
  `a2a/flatline/prd-cabt-flatline-consensus.md`. Flatline earned its keep ~4×.
- **NORTH STAR elaborated (operator, 2026-06-17):** system-of-systems / strategies-of-strategies — councils of
  constructs deliberate strategy (words) -> **onomancy** (words->shapes) inscribes **veve** shapes -> **asson**
  attests (can't-forge + re-runnable) -> **legba** chains (fraud-proof by re-execution) -> loa-cli compiles ->
  **cabt settles** -> Finn Brier-scores. **Grounding (grepped loa-cli+loa-laplas):** onomancy = the discipline
  (NO literal module); asson/veve/legba = the real loa<->laplas **record-contract** ("grade the record, not the
  outcome" — `loa-cli/.../loa-laplas-record-contract.md`). **Contest folded:** record-contract grades work REAL
  not GOOD -> needs 3 legs (asson=honest · cabt=good · Finn=trustworthy); recursion must terminate at an
  EXECUTABLE veve -> **Simulation = the floor+termination of the tower, not a sibling**; council-as-theater = the
  known `construct-adapters-ignore-task-inputs` defect, asson+settle is the structural guard. Doc:
  `context/2026-06-17-system-of-systems-north-star.md` (candidate). FunSearch = degenerate 1-construct case.
  **Sequencing: Sim floor (FR-0 spike -> ISMCTS L0) FIRST; council north-star behind it.**
- **Onomancy/onomatology CONFIRMED + grounded (operator check, 2026-06-17):** onomatology = **layer 2 of finn's
  own 5-layer truth stack** (proofs<-onomatology<-epistemology<-worldline<-straylight; `epistemology-deterministic-
  layers.md`); "names = deployed code, wrong name = standing prompt injection" (asson doctrine `words-with-teeth.md`),
  under **REL** (casual deliberate / competitive record, from tournament MTG = this domain). Onomancy = divine-by-name,
  already /compose: `find-construct.yaml` (divine which spirit) + `author-a-construct.yaml` (name a new one). My
  earlier "LLM never settles" contest = finn's OWN §4 boundary (models reason, cabt settles). **Greenlit seam design
  DELIVERED:** `context/2026-06-17-council-veve-seam.md` — strategy-veve schema (modeled on real veve.json; L0/L1/L2,
  composed_of = strategies-of-strategies, terminates at L0/cabt) + `strategy-council` /compose (stage 0 find-construct
  divines the council → gygax/arneson/fagan deliberate casual-REL → loa-cli mints named veve + registers forecast →
  asson attests competitive-REL → cabt SETTLES → finn Briers + legba chains → operator promotes). Open Qs → /architect.
- **L2 portfolio brain DESIGNED (greenlit, 2026-06-17):** `context/2026-06-17-L2-portfolio-brain.md`. Key result:
  **PSRO / EGTA is the formal name for "strategies of strategies"** (a system reasoning over a population of
  systems). 3 components mapped to finn machinery: (A) **field posterior** = WEBB SIGINT desk reads opponent
  archetypes from cabt `logs` (Bayesian, dated, `settled_until` decay); (B) **attested matchup matrix** = cabt-
  settled, Brier-scored L1×archetype payoff cells; (C) **meta-solver** = lean **Thompson-sampled best-response**
  (ships by Aug 17) → full **PSRO meta-Nash + council best-response oracle** (author-a-construct names a new L1 that
  beats the current meta = the franchise tail). 5 subs/day = explore(field-probe)/exploit budget. Contests:
  payoff-matrix cost → **active EGTA** (only deep-eval cells that move the meta-Nash); **bot-field ≠ real-field**
  (early subs are real-field probes, not ladder-climbing); matchmaking selection bias; non-stationarity → EXP3.
  Sequencing: 1 L1 floor → 3-5 archetypes + matrix → lean L2 → full PSRO. The dated/attested/calibrated metagame
  record IS the Strategy-category report. Open → /architect.
- **SDD WRITTEN (/architect, 2026-06-17):** `sdd-cabt.md` (695 lines) — consolidates prd-cabt Rev 3 + seam + L2 +
  north-star + the real `src/research/` substrate. Corpus-engine `prd.md`/`sdd.md` UNTOUCHED (their `M` predates
  this session). Key decisions: **two-runtime hybrid** (match-time agent = self-contained Python `agent(obs)->list[int]`
  ISMCTS + numpy augury <50MB + per-turn abort, forced by Kaggle ABI + closed cabt ctypes; design-time calibration =
  TS, EXTENDS `src/research/` Ledger-of-Bets not re-platform); **cabt = a new `ResearchSensor` settle instrument**
  alongside gemini/grok/dune (reuses TetlockForecast/SpineEventWriter/CostAtom unchanged; ONE new schema
  `CabtSettleRecord` w/ NFR-1 provenance); **settle boundary invariant** (LLMs model/voice/attack/propose, only cabt
  verdicts; no-prior-forecast or non-cabt verdict → fail-closed); **Python↔TS = subprocess not FFI** (one closed-engine
  binding). **Phasing:** P0 FR-0 spike (GATING) → P1 Sim floor (Aug17) → P2 calibrated iteration → P3 report (Sep14) →
  **P4 L2/council = franchise tail, OUT of V1** (designed-against, veve schema forward-compatible). 9 OQs, **OQ-1
  determinization = GATING** (weakest link; whole move-engine FR-2-vs-FR-2b pivots on it; unverified till the spike).
  4 Mermaid diagrams. **Next true unblock = cabt acquisition + FR-0 spike.**
- **SDD 3-MODEL FLATLINE DONE + folded → Rev 1.1 (2026-06-17):** TRUE 3-model headless achieved (operator ask) —
  **codex (gpt) + gemini + claude (opus via the Code CLI's session auth)**; opus works headless this way even with
  ANTHROPIC_API_KEY unset (the trick the governed orchestrator misses). ~20 findings, 7 BLOCKER-tier, 4 UNANIMOUS
  across all 3 corpora. Design-reshaping consensus: **(1) Phase 0 = ABI-CERTIFICATION gate** not just determinization
  — certify the real Kaggle calling convention (maybe `agent(obs,config)` 2-arg, not `agent(obs)->list[int]`!) via a
  5-line smoke agent actually SUBMITTED + golden fixtures + `engine.clone()` perf + seed availability; **(2) FR-2b
  pre-scoped to observable-state-only** (custom forward-model = reimplementing the closed engine, unanimous reject);
  **(3) opponent archetype belief model moves ONTO the floor** (you don't know the opp's 60); **(4) persistent Python
  worker pool** not subprocess-per-match (unanimous); **(5) promotion = paired head-to-head + SPRT, null=0.50, drop
  the saturating 0.80-vs-baseline bar; typed executable test spec not prose**; **(6) calibrate per-match/per-matchup**
  (5-15 per-promotion forecasts ≠ credible Brier); + adaptive chess-clock allocator, audit-grade `CabtMatchRecord[]`,
  sandbox the `.so`. Consensus: `a2a/flatline/sdd-cabt-flatline-consensus.md`; amendments → `sdd-cabt.md §E` (Rev 1.1).
  **HANDOFF: cabt acquisition (operator/Kaggle) is the next unblock → then the Phase-0 ABI-cert spike.**
- **Phase-0 ABI CERTIFIED from source (2026-06-17) — engine is IN the pip package!** `pip install kaggle_environments`
  bundles `envs/cabt/` incl. the compiled engine `cg/libcg.so` (Linux x86-64 ELF) + `cg/cg.dll` (Windows) — **NO
  macOS build** → can't run natively on the Mac; needs Linux x86-64 (local Docker qemu crashed twice; **Railway = the
  clean home + the SDD's planned substrate**). No Kaggle token needed to certify the ABI. **Ground-truth blocker
  resolutions:** B1 RESOLVED — `agent(obs:dict)->list[int]`, deck-as-first-action when `select is None` (opus 2-arg
  worry FALSE); B2 — `SearchBegin/Step/End/Release` EXPORTED in the .so (native lookahead; obs carries
  `search_begin_input`; not Python-wrapped; NO clone symbol → search-not-clone) → ISMCTS feasible; C4 CONFIRMED —
  RNG = std::random_device (no seed); reward = -1/0/1 (cabt.json → clean settle + PPO viable); chess-clock =
  `remainingOverageTime` 600s. Doc: `context/2026-06-17-phase0-cabt-abi-cert.md` (use_label: **usable** = ground
  truth). Scratch: `.cabt-spike/` (venv + smoke_probe.py). **Remaining Phase-0 (needs stable Linux x86-64):** live
  match smoke + the `SearchBegin` hidden-state-INJECTION test (settles FR-2 vs FR-2b) + pull `EN_Card_Data.csv`.
  Only data-tab file worth pulling = EN_Card_Data.csv (PDFs/JP not needed).
- **Phase-0 SMOKE PASSED + spike COMPLETE (2026-06-17, linux/amd64 Docker):** `env.run([random_agent,random_agent])`
  → `MATCH_DONE rewards=[-1,1] steps=54` (clean ±1 settle); all `Search*`+core ctypes symbols callable; **obs structure
  certified** — `obs=[current,logs,remainingOverageTime,search_begin_input,select,step]`, `select=[type,context,
  contextCard,deck,effect,maxCount,minCount,option,remainDamageCounter,remainEnergyCost]`, `select.option`=list, return
  `maxCount` indices (augury energy/damage math is IN the obs). **kaggle_environments 1.30.1 = latest; NO Python
  search wrappers exist** → the search API is ctypes-only → **using it = FR-2 implementation (sprint work), not more
  spike**; the SearchBegin injection test (FR-2 vs FR-2b) resolves inside building that binding. **Phase-0 verdict:
  floor de-risked, FR-2 feasible, ABI certified.** Docker works locally for one-shot probes (storage cleared); sustained
  eval → Railway (native Linux, no qemu crawl). Doc: `context/2026-06-17-phase0-cabt-abi-cert.md`. **NEXT: /sprint-plan
  the floor** (search-binding+ISMCTS+persistent Linux worker as sprint-1 highest-risk task).
- **/sprint-plan DONE → `sprint-cabt.md`** (4 sprints, Sim floor, §E honored, corpus untouched; S1=ctypes Search
  binding+ISMCTS+Linux worker LARGE, S2=augury+belief-posterior+baselines+eval, S3=settle-sensor+SPRT+receipts,
  S4=clock+poteau+package+first-submission). 0 beads created (deferred to /implement).
- **COUPLING FINDING (2026-06-17, important):** the cabt SDD reuses `src/research/` calibration infra
  (TetlockForecast/spine/CostAtom) that is **uncommitted WIP on corpus-engine — NOT on main, not committed anywhere**
  (main has 0 src/research files). So cabt is architecturally DOWNSTREAM of corpus-engine. **Sprint 1 (Python move
  engine) is self-contained** (no src/research dep) → builds standalone now; the **Sprint-3 calibration integration
  depends on corpus-engine's src/research landing on main** (commit/merge) — the real coupling point.
- **WORKTREE set up for the cabt build (operator chose, 2026-06-17):** `git worktree
  /Users/zksoju/Documents/GitHub/loa-finn-cabt` on **`feature/cabt-sim-floor` off main** (5b28c428); cabt
  prd/sdd/sprint promoted to CANONICAL there + 8 context docs copied; src/research=0 (clean); corpus-engine tree
  FROZEN/untouched. **Build-execution open Q:** Loa `/run`/`/implement` skills are session-rooted at THIS repo
  (corpus-engine), so the worktree build wants a NEW session rooted in `loa-finn-cabt` (`cd … && claude` → run there),
  OR build Sprint 1 manually targeting the worktree paths. The worktree's `.claude` is main-era (65 commits behind;
  System-Zone, ≈fine). Spike scratch (smoke_probe.py) copied to the worktree's `.cabt-spike/`.
- **WORKTREE REVERSED → building IN-REPO (operator questioned the frame, 2026-06-17):** the worktree was
  over-engineered AND counterproductive — off-main it had ZERO `src/research`, **severing cabt from the calibration
  substrate it depends on** (the coupling above). cabt code = NEW files (`src/cabt/…`) that don't conflict with
  corpus-engine's *modified* files, so same-tree is clean and keeps cabt next to `src/research`. The worktree only
  "solved" Loa's one-canonical-cycle tooling rigidity — which the **headless 3-model review** (proven) serves better.
  Torn down (`git worktree remove --force` + branch deleted + pruned); corpus-engine tree + 50-file WIP intact.
  **Build posture:** in-repo, `src/cabt/` new files, gated by the headless 3-model review (not the rigid /run-canonical
  state machine; operator-directed). Sprint-1 task-1 (ctypes Search binding) STARTED: `.cabt-spike/search_probe.py`
  (safe format-characterization first — wrong ctypes argtypes segfault) running in linux/amd64 Docker (bg). Resolves
  the FR-2 (determinized ISMCTS) vs FR-2b (observable-state) fork.
- **FR-2/FR-2b RESOLVED → FR-2 (cabt `api.html` docs, 2026-06-17):** the search API is a **determinized-search
  interface BY DESIGN** — `search_begin(obs, your_deck, your_prize, opponent_deck, opponent_prize, opponent_hand,
  opponent_active, manual_coin=False) -> SearchState{observation, searchId:int}`; `search_step(search_id:int,
  select) -> SearchState`; `search_end/release`. You INJECT predicted opponent hidden info + control coin flips
  (manual_coin). → **FR-2 is the intended design; FR-2b is MOOT.** ISMCTS over (sampled opp state × sampled coins),
  belief model supplies samples. `searchId` = INT handle (not a pointer — why raw-C SearchStep guesses segfaulted:
  passed SearchBegin's struct-handle + incomplete args). The friendly **`api` module is documented but NOT in pip**
  (only cabt.py+cg/{sim,game}.py) → production binding = obtain the `api` module (Kaggle download/notebook) OR
  replicate over C symbols per the documented contract. **Discipline:** raw-ABI segfault-guessing was the wrong move;
  api.html was the canonical source — read docs first (grounding). Spike probes: `.cabt-spike/search_probe{,2,3}.py`.
  **NEXT acquisition: the cabt `api` module** (Kaggle competition Code/sample_submission, or the notebook env).
- **`api` MODULE ACQUIRED + determinization pattern grounded (2026-06-17, operator Kaggle-authed):** the api module
  is **`cg/api.py`** in the competition's **`sample_submission/cg/`** bundle (Kaggle Data tab, `pokemon-tcg-ai-battle`),
  import = **`from cg.api import search_begin, search_step, search_release, to_observation_class, all_card_data, all_attack`**
  (NOT pip — pip's cg/ lacks the search wrappers). DOWNLOADED (`.cabt-spike/dl/`): full `cg/` pkg (api/game/sim/utils
  + libcg.so/cg.dll), `main.py` (submission template: `to_observation_class(obs)` → `obs.select`; deck.csv reader w/
  `/kaggle_simulations/agent/` path), `deck.csv` (sample 60-deck), **`EN_Card_Data.csv` (2103 rows: HP/Type/Weakness/
  Retreat/Move/Cost/Damage/Effect)**. **Determinization pattern (PROVEN by LB-860 agents — g-kari PIMC, belatijagad
  ISMCTS):** `agent_obs=to_observation_class(obs)`; predict opp state via **shuffled mirror-deck — engine validates
  LENGTH not CONTENTS** (`opp_deck/prize/hand` sized to counts; `opp_active` only when face-down `active[0] is None`);
  `search_begin(agent_obs, your_deck=, your_prize=, opponent_deck=, opponent_prize=, opponent_hand=, opponent_active=)`
  → `search_step(root.searchId,[i])` rollout → `search_release`. **Card metadata is in-engine** (`all_card_data()`/
  `all_attack()`) → augury doesn't need the CSV. **FR-2 PROVEN RUNNING** (`.cabt-spike/search_smoke.py`, Docker
  linux/amd64): injected a hypothesized opp hand (7 cards, shuffled mirror) → `search_begin` accepted it (searchId=0,
  root_select, 2 opts) → `search_step` advanced (searchId=1) → `search_release` → `DETERMINIZED_SEARCH_OK`. The
  ISMCTS move-engine foundation is DEMONSTRATED, not just designed. Scaffold started: `src/cabt/{__init__,agent}.py`
  (agent.py needs re-align to the `to_observation_class` canonical pattern). Ref agents: g-kari/poke-ai,
  belatijagad/kg-pokemon-tcg. **Remaining Sprint-1 = ASSEMBLY of proven parts:** ISMCTS tree over search_begin/step +
  augury value-fn (`all_card_data()`/`EN_Card_Data.csv`) + persistent Linux worker. Vendor `cg/` into src/ when building.
- **ISMCTS FLOOR BUILT + GATED + HARDENED (in-repo, 2026-06-17):** `src/cabt/{agent,policy,augury,search,__init__}.py` —
  a determinized 1-ply **PIMC** engine over the real `cg.api` search (lazy-imported; loads engine only at match time).
  **v1 validated:** PIMC-vs-random self-play (Docker linux/amd64) — 2/2 wins, 0 illegal picks, full legal matches
  (`.cabt-spike/pimc_match.py`). **3-model headless review (codex+gemini+claude, the gate operator chose over /run)
  found 6 REAL game-losing bugs:** (1) no per-decision time budget vs the 10-min chess-clock [unanimous BLOCKER];
  (2) determinization — `opponent_deck` untruncated (should==deckCount) + overlapping hidden zones = impossible worlds
  [all 3]; (5) HP tie-break (±3) dwarfed the prize signal → wouldn't take winning prizes [HIGH]; (7) child-search
  leak/abort on bad leaf [HIGH]; (6/8) multi-select dumps lowest cards + minCount=0 can't decline [deferred — need
  card-aware augury]. Claude also CONFIRMED prize-direction correct + that search_step FORKS (smoke: root id 0→child 1).
  **Rev 2 folded:** chess-clock deadline from `remainingOverageTime`; disjoint+sized determinization; HP capped ±0.5
  (<1 prize); per-child try/finally + null-guards; deck cached/validated once. Local unit checks pass; **Rev-2
  re-validation 2/2, 0 illegal, no regression.** #6/#8 (card-aware multi-select) + real win-rate eval (N + SPRT) =
  Sprint 2/3. The gated-build loop (build→review→fold→re-verify) works end-to-end via the headless lane.
- **FIRST KAGGLE SUBMISSION + the submission-pipeline bug it caught (2026-06-18):** packaged the floor as a
  Kaggle bundle (`main.py` + `cabt/` + `cg/` + `deck.csv` → `submission.tar.gz`, 1.06MB) and submitted (ref
  53791925) → **ERROR'd in Kaggle validation.** Root cause (from the episode JSON the operator pulled): the agent
  CRASHED AT IMPORT before any move — **`NameError: name '__file__' is not defined`**. kaggle_environments loads
  the agent via **`exec(code, namespace)` with NO `__file__`** (agent.py:get_last_callable), so my
  `os.path.abspath(__file__)` in main.py blew up. **The local bundle-check MISSED it** because it imported main
  AS A MODULE (sets `__file__`); Kaggle execs it. **Fix:** `__file__`-safe path resolution (try `__file__`, else
  `/kaggle_simulations/agent` + cwd). **Validated the KAGGLE-ACCURATE way** — `env.run([main.py, main.py])` (execs
  the file like Kaggle, no `__file__`) → `statuses=['DONE','DONE']`. Re-submitted ref 53792481 (PENDING). Commits
  on `feature/cabt-sim-floor`: `30846f8c` (floor) + `c0af5713` (fix); corpus-engine 26-file WIP staging preserved.
  **LESSON: validate the way the TARGET loads it, not the way that's convenient** — Kaggle = exec-no-`__file__`;
  the early-submit caught a pipeline bug that a deadline submit would have wasted on. This is the SDD's
  "legal-submission floor validates the pipeline" milestone, earning its keep.
- **Option-2 increment — eval harness + card-aware augury A/B (2026-06-18):** built `src/cabt/cards.py`
  (`all_card_data()`/`all_attack()` lookups, lazy + graceful-degrade) + a `card_aware` augury mode (HP-fraction +
  KO-threat) + `.cabt-spike/eval_ab.py` (N-match PIMC-vs-greedy, Wilson 95% CI). **A/B (N=20 each): `card_aware`
  REGRESSED — 0.30 win-rate vs `prize_only`'s 0.70 vs greedy (i.e. WORSE than greedy itself; CIs [0.15,0.52] vs
  [0.48,0.85]).** Why: the KO heuristic misleads — `best_attack_damage` ignores energy cost (credits unaffordable
  attacks), weakness ×2 is a crude proxy, a 1-ply "KO threat" is illusory before the opponent responds, and the
  ±0.9 board term dominates early-game choice when prizes are tied. **NOT promoted — default reverted to
  `prize_only`** (submitted v2 already uses prize_only, so no harm). The measurement caught a regression that
  *felt* like an improvement — the loa-finn calibration gate working (SDD SPRT/promotion discipline, lite).
  **Real floor baseline established: prize_only PIMC beats greedy 0.70 [0.48,0.85]** (replaces the meaningless
  2/2-vs-random). card_aware rework (energy-aware affordable-damage + correct weakness mechanic + deeper-than-1-ply
  search) = a real Sprint-2 research task, not the quick win it looked like.
- **Multi-ply rollout lever — DEAD-END #2 (2026-06-18):** added configurable `rollout_depth` + `_rollout_value`
  (random rollout) to `policy.py`. A/B (N=18, n_worlds=2, prize_only, vs greedy): depth0=0.61, **depth2=0.61
  (tie), depth3=0.44 (worse)**. A RANDOM rollout is high-variance — random continuation evaluated by a slow-moving
  prize signal adds noise, not signal (real MCTS rollouts need many sims + a smart rollout policy). NOT promoted;
  `rollout_depth=0` stays default (infra kept, opt-in). **Meta-finding: the eval is too noisy to detect modest
  gains** (CIs ±0.2 at N=18, can't distinguish 0.61 from 0.70) → need larger N + a stronger discriminating baseline
  than greedy (flatline B3/C3 territory). **Untested core PIMC knob = `n_worlds`** (used only 2-3; PIMC strength
  IS world-averaging) → A/B 2-vs-8 running (`bwzrp1uvx`). Two measured strength dead-ends now (card_aware, rollout);
  the gate keeps the live floor clean. Eval harnesses: `.cabt-spike/eval_ab{,2,3}.py`.
- **n_worlds = the REAL strength lever — PROMOTED + SHIPPED (2026-06-18):** A/B (N=20 vs greedy): n_worlds=8 → 0.65
  vs n_worlds=2 → 0.30 (+0.35, large effect, canonical PIMC result: more determinized worlds = better hidden-state
  averaging). Bumped default cap 4→16 (deadline-governed). **Also fixed the time budget** — the engine enforces
  **`actTimeout`≈1s/move + a ~60s overage bank** (the episode JSON config; NOT the 10-min I'd assumed). Deadline now
  targets 0.85s w/ bank-aware backoff. Validated: **max 0.41s/decision emulated, 0 over actTimeout, DEADLINE_HELD**,
  env.run(paths) DONE/DONE. **LEADERBOARD: v2 (n_worlds=4) COMPLETE publicScore 594.9; v3 (n_worlds=16) submitted
  (ref 53792985, pending) — should score higher.** Three strength A/Bs this session: card_aware augury REJECTED,
  multi-ply rollout REJECTED, **n_worlds ACCEPTED** — the eval gate working exactly as designed (ship measured gains,
  reject vibes). Commits on `feature/cabt-sim-floor`: floor → __file__ fix → augury-A/B → n_worlds+deadline.
- **COMPETITOR LANDSCAPE DIG (2026-06-18):** the top of the board is **rule-based heuristic + a strong DECK +
  never-forfeit reliability** — NOT search/RL/neural-nets. Verified: top public repos ~893-915 (Jun-Morita Lucario
  915, Beiciccc 893); live leaderboard 1100-1300 (newer). **Search UNDERPERFORMS hand-heuristics on the live ladder**
  (a competitor's belief-PIMC scored 850 < his rule-based 915 — same finding as our noise problem). Learned value
  nets LOSE; RL ~697; AlphaZero unproven. **Deck choice = the single biggest verified lever (same engine 423→893).**
  **LLM = an OPEN NICHE:** zero runtime-LLM, zero LLM-deckbuilding agents; in-match LLM rejected by the field (CPU/1s
  budget); **offline LLM-driven deckbuilding/meta-selection is the defensible unclaimed wedge** + targets the real
  lever. Dig: `task ac1a239f`. **Operator reframe: not necessarily winning the ladder — cabt = a research substrate
  for the calibration loop + LLM-strategy-author.** Plan: deck swap now (bank the lever empirically) → LLM-architect.
- **DECK A/B — deck ⊗ engine interaction (2026-06-18):** swapped in Beiciccc's verified Mega Lucario ex deck (893
  list, `.cabt-spike/decks/lucario.csv`). A/B (PIMC n_worlds=8, both seats, vs the sample deck): **Lucario LOST 0.40
  (12/30; seat0 0.53 / seat1 0.27 — big first-player gap, hence both-seats).** Why: **a strong deck needs a strong
  PILOT** — Mega Lucario is an evolution/setup deck (Riolu→Lucario, energy sequencing, Hariyama backup) our prize-only
  PIMC can't pilot, so it wastes the deck. The dig's 423→893 was with TUNED heuristic pilots. **The eval caught a 3rd
  "obvious" non-improvement.** Insight: our weak engine wants a SIMPLE deck → testing satory074's mono-{F} aggro
  (Basic attackers, no evolution, attack T1; `monofighting.csv`, name→id mapped via EN_Card_Data) vs sample.
  **RESULT: mono-F also LOST 0.33 (10/30) — WORSE than Lucario. BOTH deck swaps lose to the sample deck.**
  **CONCLUSION: no deck swap helps our engine — the PILOT is the bottleneck, not the deck.** The sample deck is the
  most "play-it-dumb-and-it-works" of the three; a strong/aggro deck needs a smart pilot we don't have. 4th measured
  non-improvement (card_aware, rollout, Lucario, mono-F — all eval-rejected). Matches the dig: winners = tuned-
  heuristic pilots + decks; SEARCH (ours) underperforms. **The ladder ceiling for us = the ENGINE/pilot's game-
  understanding, which is the hard hand-tuned-heuristic grind the operator isn't chasing.** → **LLM-next reframed:
  the niche-empty + bottleneck-hitting move is LLM-authors-the-PILOT (FunSearch — LLM writes the heuristic strategy
  the winners hand-code, measured by the eval loop), NOT LLM-designs-decks (decks need a pilot). This = the
  system-of-systems north star + the real limiter + the empty niche.** Research already banked: a measured agent +
  proven calibration loop + a clear map of what wins this game (deck+reliability+heuristics > search), all eval-gated.
- **FUNSEARCH — the north star demonstrated (2026-06-18):** operator chose "LLM-authors-the-PILOT." The loop ran:
  **v1** (`src/cabt/heuristic.py`, LLM-authored heuristic, NO search) authored BLIND from the dig's enum list →
  **LOST 0.17 vs greedy** (5th eval-rejection; ungrounded = the operator's own "read the source first" sin). →
  **GROUNDED:** instrumented a real game (`/tmp/instrument_obs.py`) — sel.type=0 MAIN (45×) offers ATTACH/PLAY/EVOLVE/
  ATTACK/END; **ATTACK ends the turn.** Diagnosis: v1 made ATTACK top-priority → attacked before developing → threw
  away setup. → **v2** (develop-first: ATTACH/EVOLVE/PLAY high, ATTACK only for the +1000 lethal or last resort) →
  **BEATS our PIMC 0.77 (23/30, CI [0.59,0.88]); ≈greedy 0.43.** **An LLM-authored heuristic beat the search engine
  we built all session — in 2 grounded iterations, all eval-measured.** The north star in miniature (one author =
  the degenerate one-construct case; full = gygax/arneson council + automated mutation). Confirms the dig + the whole
  session: the PILOT's understanding was always the bottleneck, and an LLM can write it. Artifacts: `src/cabt/
  {heuristic,cards}.py`, `.cabt-spike/eval_funsearch.py`. NOT yet wired into the submitted agent (operator not chasing
  rank) — but it IS our strongest pilot (> PIMC). Next loop iterations: beat greedy too; scale to a council.
- **THE SMOKING GUN — our eval is MISCALIBRATED to the ladder (2026-06-18):** the live leaderboard scored
  **v3 (n_worlds=16, our local "win") = 539.4, BELOW v2 (n_worlds=4) = 585.7.** Our ONE accepted strength gain
  (n_worlds, won the local A/B 0.65 vs 0.30 vs greedy) scored WORSE on the real ladder. This is the dig's literal
  warning ("local non-mirror win-rate ≠ saturated-ladder improvement") + flatline's "bot-field ≠ real-field" made
  real. **CONSEQUENCE: every local A/B verdict this session (5 rejections + 1 acceptance) was judged by a proxy that
  doesn't predict the target — including the FunSearch v2 "win" (0.77 vs PIMC LOCALLY). v4's ladder score is the real
  test, not our self-play number.** Deepest loa-finn finding of the session: the calibration LOOP's validity IS the
  research question, and the real world (ladder) just showed our measure is miscalibrated. **REFRAMES Phase 2: scaling
  a council on a miscalibrated eval amplifies the miscalibration — so CALIBRATE THE EVAL FIRST** (stronger/diverse
  baselines than greedy, larger N/SPRT, or treat ladder submissions as the gate) before scaling out. Caveat: ladder μ
  is TrueSkill-like + still accumulating games, so v3<v2 is a strong signal but not yet stable. Commits:
  floor→__file__→augury→n_worlds→FunSearch-heuristic→heuristic-default.
- **REFINEMENT (v4 = 600.0):** the eval is **low-resolution, NOT inverted.** v4 (heuristic) = 600.0 ≥ v2 585.7 >
  v3 539.4 — so the LARGE local effect (heuristic beats PIMC 0.77) DID transfer to the ladder; only the SMALL noisy
  n_worlds effect inverted. **Usable rule: trust the eval for big effects, distrust it inside the noise band**
  (±0.2 at N=15-30 vs greedy). BUT μ₀=600 is the baseline + v4 was submitted minutes before reading → **600.0 is
  likely the un-moved fresh baseline, not yet a real signal** (v2/v3 sank BELOW 600 as games accumulated). So the
  heuristic's true transfer is TBD. Lesson: calibration is hard at EVERY layer — the local proxy inverts on small
  effects AND reading the ladder itself can hand you a baseline mirage. Deliverable written:
  `context/2026-06-18-cabt-research-findings.md`. Operator path 3→1→2: consolidate(done)→calibrate-eval→scale-council.
- **CALIBRATION EXPERIMENT (Phase 1, 2026-06-18):** tested "miscalibration = weak sparring bot (greedy)" by running
  n4-vs-n16 three ways (head-to-head, vs greedy, vs strong heuristic), N=30 each. **Hypothesis FAILED** — strong bot
  did NOT clearly calibrate: head-to-head 0.47 (tie), vs-greedy n16>n4 (0.53>0.43), vs-heuristic n4>n16 by 0.03
  (noise). **All three put n4≈n16 WITHIN the noise.** Real finding: the effect is below the resolution of any N=30
  single-bot eval; the v3<v2 "miss" is most likely NOISE on both ends (small effect, under-powered locally + early
  ladder μ). **Calibration rule = the eval's resolution is set by N (power) + effect size, NOT bot strength: trust it
  for LARGE effects (transfer confirmed), use ladder-scale N/SPRT or the ladder itself for SMALL ones. Local eval =
  coarse pre-filter; ladder = fine gate. Don't burn submissions on locally-indistinguishable tweaks.** Harness:
  `.cabt-spike/eval_calibration.py`. Phase 1 = a real result (envelope known).
- **LANDED (2026-06-18).** v4 (heuristic) climbed 600.0→**648.1** with games — ABOVE the 600 baseline + clearly >
  v2 585.7 / v3 539.4: **the FunSearch pilot's local win (0.77) TRANSFERRED to the real ladder** (large effects
  transfer, confirmed). Our best agent is the LLM-authored heuristic. Session closed clean: 6 cabt commits on
  `feature/cabt-sim-floor`, corpus-engine src/research staging preserved (pathspec commits throughout), deliverable
  `context/2026-06-18-cabt-research-findings.md` (§8 = the seed decision-ledger). **NEXT (operator, Phase 2 fresh):
  STUDY OUR OWN DECISION-MAKING** — dogfood loa-finn's `src/research/` probe on this session's decision trace
  (real predictions + ground-truth ladder outcomes), Brier-score it. Reflexive calibration = the appraiser before
  the generator (council). NOT the council first.

### /ride EXP-004 grounding pass (2026-06-12)

Re-rode loa-finn through the EXP-004 graduation-gate lens (real sybil layer + labeled validation
harness). Central finding, fully grounded: **the deterministic score formula is built and unit-tested;
the substrate around it is not validated** — the #269 lesson made literal in-repo.

- **Score reality** (`src/score`, branch `feature/score-phase1`): Sprint-1 pure core
  (`leaderboard/features/cluster/screen`) DONE + unit-tested. Edge adapters BOTH throw
  `NotImplementedError` (`edge/adapters.ts:22,36`) → fixture-fed only. Screen is internal-only
  (`screen.ts:5` "NOT posted"). `precisionBar` (`screen.ts:37`) is a carried contract placeholder, no
  precision/recall harness. **EXP-004 ≡ Sprint 2 (real Base/ACP ingestion) + Sprint 3 (FR-2a validation
  harness)** of `sprint-finn-score.md:104-189` — pre-registered, unbuilt.
- **Stale theses flagged**: (1) `arch-finn-cost-of-play.md:16` "infra-dominated" is FALSIFIED by its own
  `readout.json` (H1 93.7% inference, H2 R²=0.018, H3 74 ms). (2) PRD "credit bureau"/horizontal framing
  is stale vs EXP-003 **GO-vertical / NO-GO-horizontal** (2026-06-12); no-LLM determinism is now a moat
  (`exp3-c2-settle.md:46-52`).
- **Aligned/healthy**: cost meter 3-ledger (`cost-atom.ts`) ↔ `experiment-economics.md`; substrate
  executor real; observatory spine wired (`refresh-data.mjs` → `data.generated.json`).
- **Carried CRITICAL (still open)**: `package.json:6` license `MIT` vs actual AGPL-3.0.
- Did NOT regenerate prd.md/sdd.md or the finn-economy-os product docs (precedent from 06-08; stale
  claims flagged in drift-report.md §2-3 for operator-promoted amendment, not auto-overwritten).
- Outputs refreshed: `drift-report.md` (primary), `reality/{index,architecture-overview,.reality-meta}`,
  `consistency-report.md`, `governance-report.md`, `trajectory-audit.md`.

### /ride --enriched re-analysis (2026-06-08)
Re-rode loa-finn (supersedes stale cycle-013 reality, Feb 11). Codebase grew ~3x: 28 modules /
359 non-test files / ~81.6K LOC / 374 tests (was "15 modules, 120+ files"). A whole economic/NFT
layer landed undocumented in the README module map: `nft`(73), `x402`(17), `credits`(16),
`billing`(13), `substrate`(12), `marketplace`, `events`, `oracle`, `tracing`.

Ride results: drift 6.5/10 · consistency 8/10 · governance 9/10 (230 semver tags).
**Critical drift**: `package.json` `"license":"MIT"` contradicts AGPL-3.0 (`LICENSE.md`+README) → GAP-001.
7 gaps filed (`gaps.md`, session `a51c`); 2 ADRs catalogued (`reality/decisions.md`); 30 domain
terms (`reality/terminology.md`). Reality files refreshed (9 spokes, ~5.8K tokens).

**Judgment call**: `prd.md`/`sdd.md` are genuine hand-authored feature docs (Per-NFT Personality,
2026-03-26) — NOT overwritten. Ride output written to `prd-ride-reality.md` / `sdd-ride-reality.md`.
Phase 8 legacy-deprecation skipped (would have wrongly deprecated SECURITY/CONTRIBUTING/README).
Artifact verification: 20/20 persisted.

### Finn PRD discovery — the Score-truth-agent reframe (2026-06-08)
`/discovering-requirements` for a NEW Finn/Economy-OS PRD (→ `prd-finn-economy-os.md`; do NOT touch
Cycle-040 `prd.md`). Operator pivoted the spine mid-discovery: first SKU = **Score-as-a-truth-agent**
(grounded integrity scoring of tokens + agents, legit-vs-farm), NOT the vending machine. First
deliverable = **demand-discovery via a bottom-up market study** (dogfood our truth tool on the live
agent economy — ~82% theater per aGDP Epoch 5 — to map where real deal flow goes). Build target stays
**exploratory** (PLAN v3 pillars not committed). Full reframe + locked decisions + Score lineage:
`context/2026-06-08-finn-score-truth-agent-reframe.md`. Market study `w74auxo01` DONE (6 grounded
probes): the "real earner" (aixbt) is ~99% token/~31% accuracy/no audited track record; real WTP is
institutional provenance subs (Kaito ~$40M ARR). Wedge = a no-LLM deterministic aGDP leaderboard
X-ray (wash-confidence per agent), weekly X thread, 3-report experiment with falsifiable kill-gates.
**Spine ratified:** token=free-first · buyer=institutions+allocators · timing=enter-now-but-substrate-
agnostic (1→3) · posture=spike/derisk/experiment. **PRD v2 written:** `prd-finn-economy-os.md`.
GPT-5 adversarial review (via codex — governed 3-model Flatline is mis-wired here: config aliases
`gpt-5.2`/`gemini-2.5-flash` unknown to loa_cheval + opus needs absent ANTHROPIC_API_KEY; flagged, not
silently worked around). 7 blockers integrated: honesty reframe (forensic spike, NOT asserted
credit-bureau) · **defamation/legal as a Phase-1 gate** (publicly naming agents "wash-farming" =
real risk) · Distribution-GO vs Commercial-GO (WTP) split · anomaly-language + validation gate +
facts-first · auditable-not-un-gameable + token-conflict guard · adversary model · moat definition.
Demand-discovery-first sequencing was the one part GPT-5 credited. Review raw:
`a2a/flatline/prd-codex-adversarial-review.raw.txt`.
Recall finding: governed memory has nothing on this thesis (it's new — promote by operator hand only).

### Finn/Score Phase-1 sprint plan written (2026-06-09)
`/sprint-plan` over `prd-finn-economy-os.md` + `sdd-finn-economy-os.md` (Phase-1 forensic spike ONLY;
Cycle-040 `prd.md`/`sdd.md`/`sprint.md` UNTOUCHED — confirmed clean in git). Plan →
`grimoires/loa/sprint-finn-score.md` (new path, NOT `sprint.md`). **4 sprints**, mapped 1:1 to SDD §8:
S1 substrate-agnostic pure core + GraphSource port + 3 tables (FR-1/2/6, MEDIUM/6) · S2 ingestion +
epoch job + PREMISE smoke (FR-1/7, MEDIUM/6) · S3 validation harness (FR-2a, SMALL/3) · S4 report +
publication-hold + GO instrumentation (FR-3/§7, LARGE/7). All demand-gated work EXCLUDED (no
LLM/wallet/Bedrock/broker/token/MCP). SDD open Qs grounded into tasks: Q2 event-sigs→T2.1, Q3
farming-band→T2.6, Q1 precision-bar→T3.1. OD-7 legal/Q5 is a PARALLEL HUMAN track that the
publication-hold blocks on — noted, NOT an engineering sprint. SDD-referenced organs all verified on
disk; `src/score/` is greenfield.
**Ledger:** new `cycle-041`, global ids **165–168** (max prior = 164; the `next_global_sprint_id`
pointer was stale at 158 — bumped to 169). Note: ledger carries 10 pre-existing duplicate global_id
groups (126–132, 144–146) from legacy double-registration — I added ZERO new collisions.
**Beads:** 4 epics (bd-2pyh/ua3w/ajio/90cu) + 22 child tasks, epic-blocking deps S1→S2→S3→S4
(S1 unblocked root, S4 terminal). Beads SQLite was empty (5) vs JSONL (578) — reconciled via
`br sync --merge` (three-way), NOT force-flush (would have lost 255 issues). All 26 cycle-041 lines
in JSONL.

### Finn/Score cycle-041 Sprint 1 BUILT + code-reviewed (2026-06-09)
Branch `feature/score-phase1` (off HEAD, LOCAL — not pushed). Clean-tree setup first: shielded 289
pre-existing untracked `.claude/` construct installs + `src/*.js` build artifacts via
`.git/info/exclude`; the grimoires planning docs (prd/sdd/sprint/context) are git-IGNORED by Loa
convention (local-only — that's why they never commit). **S1 = the substrate-agnostic pure forensic
core** under `src/score/`: TxGraph + GraphSource port (FR-6 seam + Virtuals stub) · recomputeLeaderboard
(FR-1, net = gross − subsidy − circular) · jaccardOverlap + buyerCountDeviation (FR-2) · union-find
clustering · screenAnomaly (HIGH/MED/LOW/INSUFFICIENT, FR-2a invariants by construction). 3 additive
drizzle tables + hand-written migration `0002` (drizzle-kit generate has a pre-existing bigint bug;
migrations here are hand-maintained). vitest config: added `src/score/` to the grep root (mirrors
substrate). **GPT-5 codex code-review found 2 HIGH + 3 MED real bugs — all fixed** (branch-order
downgrade, subsidy-alone-HIGH over-accusation, Number(bigint) threshold flip, inconsistent agent
universe, cluster-threshold coupling). **26/26 tests pass, src/score typechecks clean.** Commits:
99355d27 (planning state) · 104bf95d (S1 impl) · 7b083ce6 (beads close) · cb0a5738 (review fixes).
AC verification: `a2a/score-sprint-1/reviewer.md`. Flatline mis-wired in this repo (loa_cheval aliases
gpt-5.2/gemini-2.5-flash unknown + opus needs absent ANTHROPIC_API_KEY) → used codex as the working
cross-model lane for both PRD and code review.

## Learnings

### TypeBox FormatRegistry Footgun (cycle-033, T-3.9)

**Symptom**: `Value.Check()` silently passes invalid UUIDs and date-time strings.

**Cause**: TypeBox's `FormatRegistry` starts empty. Schemas using `{ format: "uuid" }` or
`{ format: "date-time" }` constraints will pass _any_ string if the format checker is not
registered first. The `import "./typebox-formats.js"` side-effect import registers these
formats, but side-effect imports are fragile — test runners may hoist or reorder imports,
and tree-shakers may eliminate "unused" imports.

**Fix (defense-in-depth)**:
1. **Side-effect import**: `import "./typebox-formats.js"` at module top (primary).
2. **Runtime guard**: Check `FormatRegistry.Has("uuid")` before `Value.Check()` and throw
   an explicit error if not registered (belt-and-suspenders, T-3.2).
3. **Test setup**: `tests/setup/typebox-formats.setup.ts` registered as vitest `setupFiles`
   ensures formats are available regardless of test order (T-3.3).

**Reference**: Bridgebuilder review Finding F4 (Medium), PR #107.

### Routing Vocabulary: 6 TaskTypes → 5 RoutingKeys (cycle-033, T-3.9)

**Decision**: Protocol defines 6 `TaskType` values: `code_review`, `creative_writing`,
`analysis`, `summarization`, `general`, `unspecified`. These map to 5 `NFTRoutingKey` values:
`code`, `chat`, `analysis`, `default` (×2), with `summarization` mapping to `analysis`.

**Rationale**: `summarization` and `analysis` are both "deep-think" tasks requiring
reasoning-capable models. Merging them at the routing layer keeps pool configuration simple
(5 slots per personality, not 6) while the protocol retains semantic precision for telemetry.
This parallels Kubernetes CRD extensibility — multiple API resources can map to a single
controller when the execution characteristics are equivalent.

**Compile-time safety**: `mapKnownTaskType()` has no `default` branch — if a new protocol
variant is added to the `TaskType` union, TypeScript will produce a compile error until the
mapping is updated (T-3.1).

**Reference**: Bridgebuilder review Finding F5 (Medium) + F10 (Medium), PR #107.

### KnownFoo Exhaustive Pattern (cycle-033, T-4.4)

**Pattern**: Exhaustive mapping over a known subset of an open union, with safe fallback
for unknown variants. Solves the TypeScript problem where `TUnion<[...literals, TString]>`
collapses to `string`, making exhaustive `switch` impossible.

**Structure**:
1. **Closed inner function** — `mapKnownTaskType(taskType: KnownTaskType): NFTRoutingKey` with
   no `default` branch and a `never` check. TypeScript compile error if a known variant is
   unhandled.
2. **Known set** — `KNOWN_TASK_TYPE_SET: ReadonlySet<string>` derived from the `KNOWN_TASK_TYPES`
   const array. Runtime O(1) membership test.
3. **Open wrapper** — `mapTaskTypeToRoutingKey(taskType: TaskType): NFTRoutingKey` narrows via
   Set guard, delegates known values to the inner function, falls back to `"default"` for
   unknown strings.

**Parallels**:
- **Android API Levels**: Known API versions have deterministic feature sets; unknown future
  versions gracefully degrade to the highest known level.
- **Protobuf open enums**: Known values are typed; unknown wire values are preserved as integers
  without breaking the protocol.

**Implementing files**: `src/hounfour/nft-routing-config.ts` (`KnownTaskType` + `mapKnownTaskType`).

**Applicability**: Any protocol union that may grow new variants upstream — `AccessPolicyKind`,
`ReputationEventKind`, future `GovernanceMutationKind`. The pattern ensures loa-finn handles
known variants exhaustively while remaining forward-compatible with unknown ones.

**Reference**: Bridgebuilder Deep Review Finding 2 (PRAISE), PR #107.

### Autopoietic Loop — Design Sketch (cycle-033, T-4.5)

**Concept**: A 6-stage feedback cycle where quality measurement influences future model
selection through reputation:

```
quality_signal → reputation_event → reputation_store → tier_resolution → model_selection → quality_measurement
      ↑                                                                                          ↓
      └──────────────────────────────────────────────────────────────────────────────────────────┘
```

**Current state (v8.2.0)**:
- Stages 1-2 **built**: `scoreToObservation()` emits `QualityObservation`, `normalizeReputationEvent()`
  validates and normalizes all 4 `ReputationEvent` variants.
- Stages 3-4 **partially built**: `resolvePool()` in `tier-bridge.ts` maps routing keys to NFT
  pools, but does not yet query reputation data to weight pool selection.
- Stages 5-6 **not wired**: No consumer reads reputation scores to influence which model
  handles a given task type.

**Gap**: The loop is open between stages 2 and 4. `normalizeReputationEvent()` produces
normalized events but nothing consumes accumulated reputation to influence `resolvePool()`.

**Integration point**: `resolvePool()` could query dixie's `PostgresReputationStore` to weight
pool selection based on model performance history. This would close the loop:
poor-performing models receive fewer tasks, high-performing models receive more.

**Status**: SPECULATION — not blocking merge. Candidate for a future cycle. The prerequisite
is a reputation query interface from dixie that loa-finn can call at routing time.

**Reference**: Bridgebuilder Deep Review Finding 5 (SPECULATION), PR #107.

### Trust Infrastructure — Three-Legged Architecture (cycle-033, Sprint 6)

**Architecture**: The trust infrastructure spans three repositories, each owning a distinct
verification domain:

| Leg | Repository | Domain | Verification Status |
|-----|-----------|--------|-------------------|
| **finn** | `loa-finn` | Format validation, capability negotiation, routing, quality observation | Verified (Sprint 4-6) |
| **freeside** | `loa-freeside` | Economic conservation, credit lots, x402 payment protocol | Partial E2E |
| **dixie** | `loa-dixie` | Knowledge freshness, conviction voting, reputation aggregation | Unit only |

**Current verification per leg**:
- **finn**: Protocol handshake negotiates capabilities (Sprint 4). KnownFoo pattern applied to
  TaskType and ReputationEvent discrimination (Sprint 3 + Sprint 6 T-6.1). Quality observation
  pipeline instrumented with metrics (T-6.3). Reputation query interface defined (T-6.2).
  Quarantine records use commons schema (T-6.4). Integration test covers stages 1, 4-6 (T-6.5).
- **freeside**: Conservation laws verified via `BillingConservationGuard` (Sprint 5 T-5.4). Audit
  trail hash chain with integrity verification (T-5.6). Economic invariants schema-validated.
- **dixie**: Unit tests only. Reputation store and conviction voting not yet E2E verified.

**Autopoietic loop status (updated Sprint 6)**:
- Stage 1 (quality signal): `QualityGateScorer.scoreToObservation()` — **instrumented**
- Stage 2 (reputation event): `normalizeReputationEvent()` with KnownFoo — **built**
- Stage 3 (reputation store): dixie `PostgresReputationStore` — **not integrated**
- Stage 4 (tier resolution): `resolvePoolWithReputation()` — **built** (accepts `ReputationQueryFn`)
- Stage 5 (model selection): `PoolRegistry.resolve()` — **built**
- Stage 6 (quality measurement): `QualityObservation` schema-validated — **instrumented**

**Prerequisites for closing the loop**: All three legs must be E2E verified. The critical gap is
Stage 3: dixie's reputation store must expose a query interface that finn can call at routing time.
`ReputationQueryFn` (T-6.2) defines the contract; dixie must implement the provider.

**Trust analog** (web4 manifesto): "Trust must be verified, but verification patterns can be
universal." The three legs share commons schemas (`QuarantineRecordSchema`, `AuditEntrySchema`,
`QualityObservationSchema`, `ReputationEventSchema`) ensuring consistent verification across
the trust boundary.

## Blockers

## Session 2026-06-09 — cost-of-play reframe (cycle-041 → service-agent economics)

Finn reframed: service-agent/operator CONSUMING Score API verdicts behind a Markov blanket; the open
risk is marginal economics, not analysis capability. Forks resolved: verdicts-consumer (score island
stays, producer-side architecturally) · Railway vs payload-real stub · ad-hoc composition.

- **Design (build-from doc):** `grimoires/loa/specs/arch-finn-cost-of-play.md` — representative call
  (`/api/v1/score/verdict`, Class A relay / Class B cheval-enrich), 3-ledger CostAtom, fail-closed
  cheval-ROI gate (incl. no-inference-on-abstain), lean image, pre-registered H1 ≤20%/>40%.
- **Composition run PROVEN:** `cost-of-play-0609b` → `valid_run`, digest sha256:b5986c43…;
  `compositions/cost-of-play.yaml` authored ad-hoc (the-weaver naming pending).
- **Runtime finding:** construct adapters ignored task-mandated reads 4/4 → 4 clews captured;
  executor grounded via Explore + merged at seams with operator ratification.
- **Score API exists** (research-stage): 0xHoneyJar/score-api PR #263 — layered fact-sheet verdict,
  abstain-by-default; ACP escrow economy tiny ($30 top earner) → marginal-cost scope only.
- **Next:** micro-sprint the V1 checklist (items 1–4 are /implement-gated app code), deploy, run
  playtest phases 0–3, readout vs pre-registered bars.

## Session 2026-06-10 — DEPLOYED: cost-of-play live on Railway · phase 0 COMPLETE · program reframe

**Deploy (experiment #1 production lane):** project `finn-cost-of-play` (honey jar workspace,
c997cf7f…) · `score-stub` (dockerized — Railway upload root = git root, railpack saw repo
package.json; own Dockerfile fix) · `finn-lean` live at finn-lean-production.up.railway.app
after 3 deploy-discovered fixes: (1) BEAUVOIR.md is boot-blocking but lean cut grimoires/ —
staged via deploy/BEAUVOIR.md because (2) the Railway indexer DROPS grimoires/ from the build
context even for tracked files; (3) volume mounts root-owned over /data vs non-root finn user →
`RAILWAY_RUN_UID=0` (playtest-scope deviation from non-root posture, documented).
**Railway prices VERIFIED (docs): vCPU $0.000463/min = 2× the assumption** (RAM/egress matched)
→ arch doc row corrected, `COP_INFRA_CONTAINER_MICRO_PER_HOUR=41640` deployed.
**Phase 0 production: 5/5** (3A relay · 2B fail_closed — no funded key yet, by design), ~200-500ms,
gate echoes correct. 200-response ⇒ atom durably appended (audit-verified contract).
**Class B = Bedrock (operator correction, wired 2026-06-10):** finn's lane is Bedrock, not
OpenAI. This repo's cheval.py has no bedrock transport BUT Bedrock's OpenAI-compat endpoint
(bedrock-runtime.{region}.amazonaws.com/openai/v1 + bearer API key) drives the existing
openai-compatible path with zero new transport code (cheval.py already sends Authorization:
Bearer). Key transferred from the freeside-characters Railway project (AWS_BEARER_TOKEN_BEDROCK,
never printed). Wire model `eu.anthropic.claude-opus-4-7` (the profile freeside verifiably runs,
eu-central-1). **Pricing-staleness trap caught:** DEFAULT_PRICING's opus rows are \$15/\$75 but
current opus-tier is \$5/\$25 (platform model catalog, checked 2026-06-10) — would have
overstated H1 inference share 3×. Gate config now takes explicit verified rates via
COP_CHEVAL_{INPUT,OUTPUT}_MICRO_PER_MTOK (fail-closed on garbage; billing table untouched).
At \$5/\$25: est 22,500 micro → ROI row 67.5k ≤ ~99k margin → ROUTES. Phase-1 re-run needed
(first run spanned a redeploy + was all fail-closed B).
**Pending operator:** `railway login` refresh + `railway ssh keys github` for volume JSONL pull
at readout · stale DEFAULT_PRICING/ANTHROPIC_PRICING rows flagged for a follow-up fix (billing
undercharge risk is the OPPOSITE direction — overcharge — but stale either way).

**Program reframe (operator):** the deploy = experiment #1 of a grounded-reality loop —
hypothesis+bars → sim lane (gygax/arneson) + production lane → WORLDLINE binds (beliefs/predictions
as claimed beats, measurements observed, coherence = calibration). Exp-2 = agent-commerce
FORENSICS (brief: `grimoires/loa/context/exp2-agent-commerce-forensics-brief.md`, status
candidate): decode ACP V1/V2 ($433M unscraped), 0xa6c9ba86 identity, wallet-friction funnel
(operator belief B1 jotted to worldline spine as claimed — tension noted: research suggests
demand-deficit alternative), beacon discovery-surface audit. Composition roster:
gygax(PULL LATEST — awareness-ladder landed)+arneson+the-arcade+worldline+**beacon** (operator:
100% include). score-api PR #263 CORRECTION folded: $438M gross / 3 ACP generations / ~95% wash /
real A2A ≈ $0 → near-zero marginal cost is the SURVIVAL condition; wedge = token-level realness
filter. Meta-process: abide by existing hivemind experiment templates; extract new only after ≥2
experiments (operator call).

## Session 2026-06-09 (build) — sprint-169 COMPLETED (cost-of-play V1 built + gated)

`/run sprint-169` full cycle, local mode (no finn origin remote — only the loa framework
remote exists; cycle-041 stays a local branch by operator convention). 4 commits on
`feature/score-phase1`: impl (8 tasks) → review cycle-2 fixes (F1-F8) → cycle-3 day-bound
reservation tokens → audit fixes (A1 timing-safe bearer, A2 harness disclosure).

- **Review found real bugs** (cross-model mandate earned its keep): codex dissent caught
  6 BLOCKING incl. the InfraEstimator-never-fed AC violation (also found by self-review),
  the kill-switch concurrency race (fixed via day-bound reservation tokens reserved in the
  same microtask as the gate decision), corrupt-spend-file silent ceiling reset, and
  unvalidated cheval telemetry (float contamination path). Codex VERIFICATION pass on the
  fixes then caught the cross-midnight reservation-theft edge — two-pass dissent works.
- **Final state:** 78/78 new-suite tests · island 26/26 · full gate 4991 passed (sole fail =
  pre-existing native-runtime-spike load-flake, passes in isolation at HEAD; knownFailures
  candidate) · lean image 1.11GB (beat 1.2-1.35 target) · phase-0 smoke 5/5 atoms, sum
  invariant holds · COMPLETED marker written, ledger sprint-169 completed, epic bd-hwa1 closed.
- **Working-tree forensics:** 6 stale May-3 compiled .js files (shielded in .git/info/exclude)
  shadowed .ts sources under vitest ESM resolution → 182 phantom test failures; verified
  pre-existing via clean HEAD worktree, deleted.
- **Metering deviation (documented in report):** NativeRuntimeMeter NOT used for Class B —
  it writes into production budget/cost-ledger; the atom is the experiment's meter.
- **NEXT (operator-paced):** item 8 — Railway deploy (2 services, finn-lean 1 replica +
  score-stub private networking, env per enhance doc) → phases 0-3 → readout vs sha-pinned
  bars (`scripts/playtest/cop-bars.json`, sha b98a5716…). Verify Railway unit prices on
  dashboard BEFORE readout. Operator directs: deploy go/no-go, phase transitions, verdict.

## Session 2026-06-09 (build) — flatline transport triage

FIRST-ACT flatline on the build doc hit 3 stacked infra defects in finn's vendored framework
(May-04 vintage, predates loa#727 headless adapters):

1. **mktemp suffix bug** — `.claude/scripts/lib/invoke-diagnostics.sh:69` uses
   `mktemp …-XXXXXX.log`; macOS/BSD mktemp won't randomize non-trailing X's, creates the literal
   name once, every later run dies "File exists". Mitigation: `rm -f $TMPDIR/loa-flatline-*XXXXXX.log*`
   before each run. Upstream fix belongs in loa (System Zone here — not edited).
2. **cheval.py error masking** — `cheval.py:412` `except BudgetExceededError` raises
   UnboundLocalError (name not in scope) and masks every real transport error. Also upstream.
3. **All 3 API transports dead in this environment**: OPENAI_API_KEY valid but
   **insufficient_quota** (verified direct curl) · ANTHROPIC_API_KEY unset · GOOGLE_API_KEY not in
   this cheval's env allowlist (the broken `fast-thinker`/gemini binding from the handoff).
   OpenAI circuit-breaker `.run/circuit-breaker-openai.json` was stuck OPEN from these — reset.

**Route taken:** ran the multi-model review via the main loa repo's orchestrator
(`~/Documents/GitHub/loa`, has codex/gemini/claude-headless adapters + fallback chains),
`--doc` pointed at finn's build doc, `--skip-knowledge`. Results land in
`grimoires/loa/a2a/flatline/cop-v1-build-review.json`.

## Session 2026-06-09 (plan) — cost-of-play V1 micro-sprint registered

`/sprint-plan` produced `grimoires/loa/sprint-cost-of-play.md` — ONE LARGE micro-sprint
(**global sprint 169**, cycle-041 sprint-5; ledger bumped to next_global_sprint_id 170) covering
build items 1–7 of `specs/enhance-finn-cost-of-play-v1.md`; item 8 (Railway deploy + phases 0–3)
stays operator-paced ops. Beads: epic `bd-hwa1` + 8 tasks (`bd-xbso` T5.1 atom, `bd-e4f4` T5.2 stub,
`bd-m08z` T5.3 gate P0, `bd-5dvb` T5.4 rpc counter, `bd-ops2` T5.5 lean image, `bd-viy9` T5.6 driver,
`bd-yugv` T5.7 readout+bars, `bd-a087` T5.E2E P0), deps mirror the dependency graph, label sprint:169.

**Grounded discovery during planning:** `vitest.config.ts:12` grep roots only scan
`tests/ src/substrate/__tests__/ src/score/` — the new `src/cost` + `deploy/score-stub` tests would
silently collect ZERO (exactly flatline IMP-016). T5.1 extends the grep roots + removes the untracked
`src/cost/tmp-verify.test.ts` probe; T5.E2E asserts non-zero collected counts. Also: spec cited
rpc-pool execute at :99-145; actual `execute()` is `src/x402/rpc-pool.ts:154` (plan cites :154).
Note `/Users/zksoju/bonfire/finn` is a SYMLINK to this repo (same inode) — not a second clone.

**Next:** `/run sprint-169` (implement→review→audit; decideGate + cost-atom middleware REQUIRE
cross-model review at the review gate), then item-8 deploy via use-railway, phases 0→3, readout.

## Decision Log

- **[2026-06-13] sprint-bug-170 AC#5 — veve re-attestation DEFERRED (scope-split).** The dune-meter
  fix (loa-freeside) changes the source tree, so `veve.json` `attestation.tree_hash`/`signature`
  (signed_by `436c1bd8…`) are now stale and must be regenerated via `asson attest` with the signing
  key. **Deliberately NOT done in this sprint** — forging/re-signing an attestation is a supply-chain
  ceremony that belongs to a maintainer/CI holding the key, not the implementer. The behavioral
  vectors (`--help`, `run-requires-cap`) ARE verified byte-stable (bin content diff = 0; mode-only
  change), so only the tree_hash/signature regen remains. Follow-up: re-attest on PR #282 before
  merge. Rationale: integrity > convenience — the attestation system exists precisely so signatures
  aren't forged for expedience.

## Session 2026-06-14 (research + plan + simstim) — Corpus Engine staged to the build gate

**Research (lab):** ran the realness loop's first POSITIVE control. PROBE-003 (gemini OSINT) refuted
the premise — Kintara is **Solana pump.fun ($KINS)**, not Ronin; game off-chain. SETTLE-003 (Dune
Solana `dex_solana.trades`): **29,009 traders, top-1 5.78%, +152 traders/day, growing** → **HELD[real]**
— the filter's first REAL verdict (validated as an INSTRUMENT: theater×2 + real×1). TETLOCK Brier 0.49
(desk bet 0.30 AGAINST the specimen — skeptical prior over-applied). Full: `lab/SETTLES.md` SETTLE-003,
`lab/NOTEBOOK.md` entry 002.

**New lab artifacts:** `lab/run-probe.ts` (reproducible probe runner), `lab/roster/webb.md` (WEBB
weak-signals desk), `lab/SIGINT-WIRING.md` (grok ChevalXaiRoute contract), `lab/COMPOSITION.md`
(enrich lab-cycle), `lab/gadgets/realness-verdict/` (GADGET #001, built+tested 5/5 — the SETTLE math
extracted, discrimination test executable).

**Plan → simstim (all hardened, headless 2-model flatline; opus down, 0¢):**
- `context/gadget-factory-brief.md` (candidate) — Finn as gadget factory; sell the track record, not the loupe.
- `prd.md` Rev 2 (7 integrated, 2 blockers fixed) · `sdd.md` Rev 2 §10 (6 integrated, 2 blockers) ·
  `sprint.md` Rev 2 (11 integrated, 3 blockers). Raw + consensus in `a2a/flatline/*corpus-engine*`.
- Blockers caught before code: Brier-across-horizons (use per-horizon p_survival), idempotency
  double-bill (horizon ordinal not dynamic window), window-determinism (end=fixed horizon target),
  budget TOCTOU (reserve not check). **The flatline earned its keep 3×.**

**Build STAGED, not fired (the gate, 2026-06-14):**
- Branch `feature/corpus-engine`. simstim state `simstim-20260614-6f13a505` (impl in_progress).
- Beads phase-a graph `sprint:corpus-a` (epic `bd-corpus-engine-phase-a-lqos`): T0a,T0b,T2,T3 ready;
  T4 blocked-by all 4. T1 (dune-meter) EXCLUDED — cross-repo loa-freeside.
- `sprint.md` headers aliased to `## Sprint 1..4` so `/run sprint-plan` discovers them.
- **NOT fired** because: (1) in-`/run` review/audit transport is degraded (ANTHROPIC unset, OpenAI
  quota-dead; only codex+gemini headless work, opus down) — a long unsupervised autonomous build with
  degraded quality gates shouldn't launch blind; (2) operator-paced launch is safer for the heavy step.
- **To launch Phase a:** restore review transport if possible, then `/run sprint-plan --to 1` (Sprint 1
  = Phase a) OR `/simstim --resume`. Worst case /run halts on transport via circuit breaker → INCOMPLETE PR.
- **Operator decision (operator-confirmed this session):** V1 = "Loop + survival re-settle"; compute =
  Railway Sandbox (verified available 2026-06-14, flag cleared); internal-edge (track record) before revenue.

**Indexing TCO + firehose experiment SHIPPED (2026-06-16, epic bd-idx-tco-exp-s7r5):**
- RLAIF measurement substrate on `src/research`: hash-chained `IndexingExperimentRow` ledger
  (`indexing-{ledger,crossover,seed,capture,read}.ts` + `schemas/indexing-experiment-row.ts`),
  `pnpm indexing:{seed,read,capture,test}`, 26 tests (90/90 src/research green), typecheck clean.
- Money = bigint micro-USD (no floats); toil first-class; verdict trust inherits weakest cost_source
  (Ken-Thompson invariant — a projection can't render as measured). Ledger is the git-tracked artifact.
- **Verdict** (`grimoires/loa/context/2026-06-16-indexing-tco-verdict.md`): L1 → move OFF sovereign-Ponder
  to managed; pure-$ saving ~$12/mo erased by toil at **$3.59/hr breakeven**. L2 → "millions of
  collections" doesn't exist on one chain (~406k Eth / ~40GB columnar, Dune-measured); ClickHouse 36×
  cheaper storage; no cost wall — don't build yet. Found money ~$50/mo (bd-4kf), independent.
- **Trust = vendor-quote/projected → NOT ratified.** Envio $ unpublished (Discord-quote-gated); only the
  operator's lived ~$70 exists. Ratification gate = `bd-buho` (stand up managed for a measured 1x row;
  runbook `src/research/standups/envio-hyperindex.md`). E1–E4 closed; epic open pending bd-buho.

**Reflexive calibration ledger SHIPPED (2026-06-17, Phase 2 — "study our own decision-making"):**
- Pointed `src/research/` at loa-finn's OWN cabt decision trace (§8 of the 2026-06-18 findings doc).
  The dogfood the probe+cost-atom+spine-ledger infra was built for: grade our predictions vs ground truth.
- New code (in-repo, gated by the headless 3-model review — codex+gemini+claude): `schemas/decision-forecast.ts`
  (DecisionForecast — integer-ppm Brier, effect-size axis, trust-ordered resolution instrument, assert validator),
  `calibration.ts` (resolve → Brier → **tiered** report + hash-chained ledger + `verifyCalibrationLedger`),
  `cabt-calibration-seed.ts` (the 8 decisions, deterministic, idempotent --write snapshot). **The genuinely
  missing piece: Brier scoring had only ever been done by-prompt; now a tested deterministic function.**
- Deliverables: `grimoires/loa/lab/cabt-calibration.jsonl` (8 hash-chained records, head e4dbbb51596c…, len 8)
  + `grimoires/loa/lab/CALIBRATION.md`. 30 calibration tests (120/120 src/research green), tsc clean (my files).
- **3-model review reshaped the result (the irony: a ledger about not-overclaiming first overclaimed).** Codex
  BLOCK + gemini BLOCK + claude SHIP-WITH-FIXES converged: (1) don't roll RECONSTRUCTED predictions into a
  headline calibration number; (2) don't Brier-score subjective/framing calls beside ground truth; (3) the
  large-effect bucket is CIRCULAR (rejects self-resolved by the same eval that made the prediction). Folded:
  objective/reflection tiering (`evidence_class=retrospective-demo`, `headline_eligible=false`), the honest
  headline is **n=2 out-of-sample ladder-scored predictions** (PIMC floor + FunSearch v2, both held, mean Brier
  0.0315) — consistent with calibration on large effects, NOT enough to claim it. Plus 2 real correctness bugs
  fixed (seed --write was appending→16 lines; held/falsified docstring inverted score semantics for p<0.5) and
  the ensureHead torn-tail fork (shared w/ indexing/cost-atom siblings).
- **The finding:** we have almost no clean calibration evidence yet (n=2, reconstructed) — THAT is the result.
  Instrument works; dataset to validate it barely exists. Forward fix = pre-register p BEFORE the ladder
  (`forecast-registry.ts`), resolve against the real target, accumulate. n_worlds flagged `overconfident_vs_resolution`
  (confident 0.65 call on a difference §5b proved unresolvable). Review audit trail: `.run/cabt-calib-review/`.

**CALIBRATION-002 — the forward fix (pre-registered cabt decisions, 2026-06-17):** operator chose to
fatten the objective tier rather than scale the council on n=2. Built the pre-registration path
(`registerDecision` / `resolveRegisteredDecision` / franchise rule in `calibration.ts`) + the mechanical
effect-size rule (`classifyEffectFromMargin`, claude's M5 fix — effect is data-derived, not narrator-chosen)
+ `cabt-pre-register.ts`. Pre-registered **3 genuine, open cabt decisions as LOGGED forecasts (p blind,
before any eval/ladder)** → `grimoires/loa/lab/cabt-forecasts.jsonl` (head 7e3639322c2f…, len 3): deck-Lucario
+heuristic-pilot p=0.45 (deck⊗engine retest), heuristic-v5-energy-target p=0.40 (refinement→likely small),
deeper-ISMCTS p=0.25 (bet AGAINST search). **Honest scope: grows the objective PIPELINE, not the scored count
(stays 2 until the ladder speaks).** These are the first `prediction_basis:logged` records — genuine calibration
evidence pending. Resolve via `resolveRegisteredDecision(id, {…ladder-measured…}, observedMarginPpm)` after a
submission settles. 39 calibration tests (129/129 src/research), tsc clean.

**METABOLISM-001 — the PSRO toy loop, re-derived against our substrate (bd-ryza, 2026-06-18):** building
the lab's "learning metabolism" (re-derive `psro_min.py` against loa-finn) VIA the `code-implement-and-review`
composition (`/compose`), gated by FAGAN + the terminal proof-of-run gate. Brief (grounded SoT):
`grimoires/loa/specs/bd-ryza-toy-loop.md`. Operator decisions (2026-06-18): loop in **TS** on the ledger
substrate; strategy = an opaque `vec:number[]` (ToyHand uses vec[0]; CabtHand maps vec[0..7]→`_BASE` priors);
Oracle V1 = parametric search; **ToyHand-proven + CabtHand-adapter** (real cabt can't run here — `libcg.so` is
a Linux mach-o slice, `dlopen` fails on darwin; needs a linux container, docker is available); integer-domain
receipts (no float in any `.jsonl`).
- **Segment A (Foundation) DONE + PROVEN** — `valid_run` (run `bdryza-sega-1`, envelope_digest
  `sha256:3d15e91…`, legba_receipt `sha256:e574f0d…`). 7 files under `src/lab/metabolism/`
  (types, population-ledger=Archivist, metabolism-ledger=Custodian, hand=ToyHand+CabtHand). **28/28 vitest**,
  src/lab tsc-clean, **idiom REUSED** (imports `canonicalize`/`verifyChain` from cost-atom-research +
  `GENESIS_HASH` from schemas — zero reinvention), no float contamination. FAGAN converged on merit at iter 2
  after catching a real MAJOR (vitest.config.ts grep-root missing `src/lab/` → silent zero-tests, the IMP-016
  trap) + a MINOR.
- **Open curation (deferred to Segment C):** ledgers' DEFAULT write path is `src/lab/metabolism/data/` (App
  zone, gitignored) not State zone — FAGAN's MINOR; move to `grimoires/loa/lab/metabolism/` when C wires real output.
- **Segment B (solver organs) DONE + PROVEN** — `valid_run` (`bdryza-segb-1`, envelope_digest
  `sha256:c70e149…`). cartographer.ts/oracle.ts/loyal-traitor.ts. FAGAN iter-1 caught the EXACT anti-fox trap
  (worst_case_check was a tautology that could never fail — game_value===min_col by construction); iter-2 fixed
  it with TWO independent witnesses (iteration's value estimate vs recomputed min-column) that genuinely
  DISAGREE on a non-converged solve — bound by `solver.test.ts:125` (`matches_game_value===false` on iters=1).
- **Segment C (loop + verify + e2e) DONE + PROVEN** — `valid_run` (`bdryza-segc-1`, envelope_digest
  `sha256:68e553e…`). loop.ts (runMetabolism, ports psro_min:152-201) + verify.ts (the verify.py-equivalent,
  fail-closed). State-zone path move applied (ledgers → `grimoires/loa/lab/metabolism/`). FAGAN iter-1 caught a
  MAJOR fox-hole IN THE CUSTODIAN ITSELF (a forged early/truncated false-REST passed `verifyRun` as valid:TRUE);
  fixed with two STRUCTURAL non-generator guards (warm-up + custody-vs-history stranded-cell) + an HONEST
  documented limit (valid:true is a structural binding, NOT a proof of global unexploitability — re-running the
  Oracle would make verify a generator).
- **WITNESSED end-to-end (seed 7, ToyHand):** pop 1→2→3, exploitability 333330→92433→23 micro, Leader RESTs at
  iter 2, `verifyRun` valid:true. **bd-ryza COMPLETE — the loop turns end-to-end. 54/54 vitest, src/lab tsc-clean.**
- **Residual MINORs (next session):** (1) verify's stranded-cell guard assumes ONE run per ledger file; (2)
  loop inlines `brierForTrend` instead of reusing the canonical `brierPpm` (decision-forecast.ts:193) — a small
  reuse miss FAGAN flagged, didn't block.
- **Next beads (the metabolism deepens):** bd-3i1c (8 organ roster briefs), bd-jipm (episode-data harness),
  bd-bfbh (Adjudicator Elo/TrueSkill over the population), + the CabtHand container run (real cabt in linux/amd64),
  + authoring `metabolism-cycle.yaml` (the toy NOW revealed the seams: Leader=loop/ship/rest is the human gate).
- **Observation (beads graph mis-wired):** `bd-ryza` is modeled blocked-by `bd-bfbh` (Adjudicator Elo) — looks
  REVERSED; bd-bfbh should depend on bd-ryza. Couldn't `br claim` bd-ryza as a result. Work tracked via the
  compose runs + brief instead. Worth a graph fix.
- **Infra note:** disk hit 100% (142Mi free) at session start — freed ~15GB via `docker image prune -af` +
  `docker builder prune -f` (operator-authorized). `construct-rooms-substrate` was global-only; installed it
  into the estate so `/compose` resolves here.

**METABOLISM-002 — the first GROUND-TRUTH measurements (real cabt in a container, 2026-06-18):** stood up
the real cg engine in a linux/amd64 docker container — stdlib-only, `libcg.so` loads, **~0.1s/match for
heuristic play (NOT the 30-60s feared)** so real evaluation is feasible locally in minutes. Tools (local,
.cabt-spike/, gitignored): `container_smoke.py`, `container_arena.py`, `container_verify.py` — the real cabt
Hand; the committed metabolism's CabtHand should wrap these (now fully de-risked). Findings (N=300,
seat-swapped, same deck both sides, Wilson CI):
- **The committed heuristic is statistically INDISTINGUISHABLE FROM GREEDY**: champion vs greedy
  0.537 [0.480,0.592] vs the greedy-vs-greedy null 0.527 [0.470,0.582]. Our "v4=649 FunSearch pilot" has NO
  detectable edge over random-legal-move at this instrument (any real edge < ~0.06).
- **The priors lever is DEAD (flat)**: no variant beats the champion (develop-max, the best, vs champion
  0.497). Resolves the pre-registered `heuristic-v5-energy-target` — not "likely small", ZERO at this instrument.
- **Signal DOES exist for BAD policies**: more-aggressive (attack-first) vs champion 0.380 [0.327,0.436] REAL
  DEFICIT — which PROVES the priors are actually applied (rules out a monkeypatch-fallback confound) and
  corroborates heuristic.py's develop-first lesson with fresh ground truth. Easy to be bad; hard to beat the floor.
- **PIMC search shows no edge — CONFIRMED FAIR**: first n4/rollout=0 (confounded) gave 0.25; the FAIR test
  (n_worlds=8, CABT_ROLLOUT=3, 0.5s/move, ~2s/match) gives PIMC vs greedy **0.400 [0.246,0.577]**, vs champion
  0.467 — STILL no edge. Even real search can't beat random-legal-move in same-deck play. Vindicates the
  pre-registered `deeper-ISMCTS p=0.25 (bet against search)` at this instrument.
- **THE META-FINDING (reward-hack averted):** self-play-vs-greedy is a near-USELESS instrument — reasonable
  policies all cluster at the 0.5±0.055 noise floor; only clearly-bad policies separate. The ladder (649) is vs
  the FIELD, not greedy. **Had the metabolism "climbed self-play win-rate," it would have optimized noise.** The
  real levers are FIELD opponents (bd-jipm episode-mining is now CRITICAL PATH, not optional), the DECK
  (deck-Lucario decision), and fair-config search — NOT priors, NOT self-play. The metabolism's value on its
  first real run was revealing the proxy is noise BEFORE we optimized it.

**METABOLISM-003 — the DECK was the dead variable, not the policy (2026-06-18):** deck-variety probe
(`container_decks.py`, N=60/matchup) OVERTURNS METABOLISM-002's "heuristic ≈ greedy" — that was an ARTIFACT
of the flat sample deck. DECK STRENGTH (greedy both sides): **monofighting beats sample 0.600 [0.511,0.683]**
(real deck edge); lucario LOSES to sample 0.392. POLICY edge PER DECK (heuristic vs greedy): sample 0.458
(FLAT — the broken instrument), **lucario 0.700 [0.613,0.775], monofighting 0.758 [0.674,0.826]** — the
heuristic CRUSHES greedy by +0.20–0.26 on decks that REWARD policy. The skill was always there; the sample
deck nullified it. The earlier "self-play is luck-bound" was deck-specific, NOT universal.
- ⚠ **THE SUBMISSION SHIPS THE FLAT SAMPLE DECK** (submission/deck.csv md5 == dl/deck.csv == f196fa73…) — we
  field a skilled heuristic on the one deck where skill doesn't express. Likely suppressing our ladder rating.
- **Grounded ladder CANDIDATE (pre-register BEFORE submit):** submission = heuristic + monofighting (stronger
  deck-on-deck AND expresses the +0.26 policy edge) or lucario. NOT confirmed — self-play vs greedy/deck-on-deck
  is still a proxy; the ladder is vs the FIELD's meta decks (vitalik's overfit guard: 0.76 on ONE deck vs a dumb
  opponent ≠ the field). But it's the best-grounded candidate we've had, and a CHANGE we can ship + measure.
- **Reframes the field instrument:** use REAL decks (lucario/monofighting + episode-mined field decks), NEVER
  the flat sample deck. The deck⊗policy interaction is the real game. Eval tools: `.cabt-spike/container_decks.py`.
- **DELIVERABLE (operator-directed): deck-swap candidate PREPPED + PRE-REGISTERED.** Tarball
  `.cabt-spike/submission-monofighting.tar.gz` (the live submission with deck.csv → monofighting; validated in
  the amd64 container: imports the Kaggle `cabt.agent.agent` symbol, loads monofighting(60), plays legal moves).
  Pre-registered BEFORE submit: `deck-monofighting-with-heuristic-pilot` p=0.62 (logged) in
  `grimoires/loa/lab/cabt-forecasts.jsonl` (registry head bumped to 3b7ed8d8…, valid=true, tsc clean). Operator
  uploads to Kaggle; resolves via `resolveRegisteredDecision` when the ladder settles. NOTE: lucario was the
  WRONG pick (the operator's existing p=0.45 lucario bet now has ground-truth AGAINST it — loses deck-on-deck
  0.39); monofighting is the data-backed candidate. ⚠ open: packaged `cabt.agent.agent` scored 0.58 vs greedy
  on monofighting (N=24) vs the bare heuristic's 0.76 — verifying whether the submission wraps a weaker policy
  (higher-N check running).
- **gygax design (for the 1+2 build) DONE:** `grimoires/loa/specs/gygax-cabt-design.md` — §A six STRUCTURAL
  heuristic features (the `_score` is blind to which Pokémon/energy/turn/board; lever = features not priors) +
  §B a multi-deck field-eval instrument with an anti-overfit defense (held-out deck split, greedy-as-tripwire,
  features-transfer-not-weights, pre-registration) for vitalik to stress-test.

**METABOLISM-004 — heuristic_v5 (gygax structural design) built, graded, proven (2026-06-18):** /compose 1+2
build (run `cabt-1plus2-seg1`, **valid_run**, envelope_digest `d411c8db…`, FAGAN-approved iter 1) implemented:
`src/cabt/heuristic_v5.py` (v4's `_BASE` + lethal UNCHANGED + 6 additive STRUCTURAL terms: prize-trade/KO math,
bench+evolution readiness, energy economy, retreat/status pivot, earned-attack quality, tempo — additive
`_score(opt,cur,state)`, drop-in `choose(obs,deck)`), `cards_v5.py` (degrade-to-zero accessors grounded to
api.py), `field_eval.py` (held-out deck split + conjunctive champion+pimc gate + greedy-tripwire). py_compile
clean.
- **GRADE (real cabt, N=80-160, v5 vs v4 SAME deck = policy isolation):** monofighting **0.738 [0.664,0.800]
  v5 WINS (+0.24)** (v5 vs greedy 0.825 > v4 vs greedy 0.688); lucario 0.506 ~tie; sample 0.487 ~tie. → v5 is
  NON-DOMINATED (≥ v4 everywhere, strictly > on monofighting), but the gain is monofighting-SPECIFIC + still
  SELF-PLAY (the ladder is vs the field). vitalik adversarial review running (overfit? does the edge transfer?).
- **Candidate ladder:** v4+sample (676.2, old flat) < v4+monofighting (deck-swap, submitted `53836290` PENDING)
  < v5+monofighting (best self-play candidate, NOT yet submitted). DISCIPLINE: let the deck-swap ladder result
  land FIRST (isolates the DECK lever), THEN submit v5+monofighting (isolates the POLICY lever) — one variable
  per submission slot. Tools: `.cabt-spike/container_grade_v5.py`.
- **vitalik adversarial verdict: UNSOUND — "the sound verifier was written and bypassed; a scheme nobody runs
  is a costume"** (`grimoires/loa/specs/vitalik-v5-review.md`). The v5-vs-v4 grade I ran is the cheaper/weaker
  instrument; gygax's held-out conjunctive gate (field_eval) was BUILT but not run for the decision. Three
  landing attacks: (1) SELF-PLAY is the wrong quantity — v5 was built to exploit v4's flat-EVOLVE mistake; vs a
  field that doesn't make it, v5's extra terms are mis-fire surface → v5 can win self-play yet score ≤676 on the
  ladder; (2) the DEFAULT held-out headline points at the FLAT sample deck (an information-free gate); (3) win-
  monofighting/tie-elsewhere is overfit SHAPE not transfer, and A.6 weakness uses a shaky type-proxy that helps
  on mono-color but mis-fires on the heterogeneous field (the term linking the monofighting win to ladder
  DEGRADATION). Praise: `ko_term` reads the offered option's damage (affordability-safe — dodges the card_aware
  0.30 trap); `field_eval` is genuinely sound (the decision ignored it). DECISIVE CHEAP TEST (running): field_eval
  confirm-tier, HOLD OUT lucario (train monofighting+sample) — does v5 clear champion AND pimc on held-out lucario
  (CI>0.5)? `.cabt-spike/container_field_gate.py`. The whole episode IS the separation-of-powers thesis working:
  generator (gygax) built it, executor bypassed the gate, adversary (vitalik) caught the bypass, verifier adjudicates.
- **GATE VERDICT: gate_pass = FALSE — vitalik CONFIRMED.** v5 piloting HELD-OUT lucario vs the conjunctive gate:
  champion(v4) 0.521 CI[0.458,0.583], pimc 0.550 CI[0.487,0.612] — BOTH CI-lower < 0.5, neither cleared. The
  monofighting +0.24 win did NOT transfer to held-out lucario → v5 is deck-shaped (exploit-the-sparring-partner),
  NOT a field-validated improvement. **DO NOT submit v5** (it would be the reward-hack the whole session guarded
  against). The deck-swap (v4+monofighting — DECK lever, robust: monofighting beats sample deck-on-deck 0.60
  independent of policy) stands as the live ladder experiment; v5 WAITS for the FIELD instrument (episode-mining,
  bd-jipm) to test transfer. The full loop — generator built → executor bypassed the gate → adversary caught it →
  verifier refused — IS the metabolism working on a real competition decision with a real stake (a ladder slot saved).
  Artifact: `.cabt-spike/arena_out/field_eval_results.json`. Net session levers: DECK (robust, shipped) > structural
  policy (real on monofighting but field-transfer UNPROVEN) >> priors (dead). Next unlock = REAL field opponents (episodes).

**METABOLISM-005 — the ladder FALSIFIED the deck-swap (2026-06-19): self-play is ACTIVELY MISLEADING.** The
monofighting deck-swap (sub `53836290`) scored **276.5** on the public ladder vs flat-deck v4 (sub `53796612`)
= **676.2** — a ~400-Elo COLLAPSE. The pre-registered p=0.62 resolves **FALSIFIED**, Brier **0.384** (we bet
0.62 on something decisively false → recorded evidence our self-play-grounded confidence was miscalibrated;
cabt-calibration.jsonl updated).
- **THE LESSON (upgrades METABOLISM-002/003):** self-play (vs greedy, deck-on-deck) didn't just fail to predict
  the ladder — it ACTIVELY MISLED. monofighting BEAT greedy + the sample deck in self-play (0.60, 0.76) yet
  COLLAPSED vs the field. The proxy-vs-ground-truth trap is REAL + CATASTROPHIC, not theoretical. Self-play
  numbers aren't just weak signal — they're DANGEROUS signal. The field is everything.
- **vitalik + the held-out gate VINDICATED:** v5's self-play monofighting win (0.738) would near-certainly have
  collapsed the same way. The gate (`gate_pass=FALSE`) + vitalik's refusal SAVED a second catastrophe. The
  discipline (pre-registration · separation-of-powers · held-out gate) WORKED — it caught v5 BEFORE the slot;
  it honestly scored the deck-swap miss AFTER. The system's value this session was NOT a better agent — it was
  not shipping the second wrong thing, and honestly recording the first.
- **PRACTICAL:** the 276.5 is now a COMPLETE submission — restore v4 (676.2) as the active/best entry (re-submit
  or select); do NOT leave 276.5 as our agent. Field top ~1364; v4 676.2 is below median.
- **NEXT = NON-NEGOTIABLE:** the FIELD instrument (episode-mining `bd-jipm`, REAL field opponents). Self-play is
  proven dangerous; the only valid evaluation is vs the field. Every future candidate (incl. v5) gates on it.

**GAMES-001 — the field instrument delivered: v4's real matchup table (2026-06-19).** Pulled 66 ladder replays
(52 v4 + 14 mono) via the Kaggle episode API (auth: static KGAT token in `~/.kaggle/access_token` — OAuth was
too flaky/scope-limited; tools `.cabt-spike/parse_{games,matchups}.py`). Decks DECODED from replays: v4's "flat
sample deck" is actually **Mega Abomasnow ex (Water)** — a real META deck (4 field opponents run it); mono =
Hitmontop/Okidogi (Fighting), just bad.
- **v4 (Abomasnow) matchup table — 30-22 (58%) over 52 games:** vs **Lucario (Fighting) 7-14 = 0.33
  [0.17,0.55] over 21 games**, and Lucario is **40% of the field**. vs EVERYTHING ELSE: **23-8 = 74%**
  (Dragapult 4-0, Ogerpon/RagingBolt 3-0, Bellibolt 2-0, Team Rocket 2-0, Crustle 4-3, Abomasnow-MIRROR 4-2 —
  our heuristic out-pilots other Abomasnow players). Lucario wins FAST (avg 66 steps vs 90-109 in wins = hard
  counter, not variance).
- **THE LEVER (quantified): the Lucario matchup.** v4 is a 74% deck with ONE hole. 50% vs Lucario → ~63%
  overall; the 712 rating is gated by losing 2/3 of 40% of the field. Fix Lucario = the single highest-leverage move.
- mono 3-11 (21%), loses to the whole meta incl. the Abomasnow mirror (1-3) — ABANDON (it's the live 225 anchor).
- Field meta (real, ranked): Lucario(F) dominant → Bellibolt(L) → Abomasnow(W) → Dragapult → Grimmsnarl/Sinistcha.
- This IS bd-jipm delivered from our OWN games. Open: diagnose WHY Lucario beats Abomasnow (weakness vs tempo)
  → tech the matchup / switch deck / adopt Lucario.

**GAMES-002 — Lucario-loss diagnosis: the Abomasnow deck is ENERGY-FLOODED (2026-06-19, decisive).** Read the
actual v4 Lucario-loss replay lines (`.cabt-spike/parse_*`, step-by-step arcs). NOT a weakness double-KO — a
BOARD-ESTABLISHMENT failure. Across 52 v4 games: our avg MAX bench in LOSSES = **0.8** vs WINS = **1.7**; fast
losses (20-76 steps) sit at bench 0-1 while opponents bench 4-5. We field a LONE Pokémon → fast decks KO it →
**"no Pokémon to promote" loss at 6-6 prizes** (the 20-step game: a full turn 0, benched NOTHING). **ROOT CAUSE
(certain): the deck is 10 Pokémon / 35 ENERGY / 15 Trainer** — 58% energy, ~6 basics. Energy-flooded hands →
can't build a board. The heuristic's under-benching is DOWNSTREAM (can't bench Pokémon it never draws); v5's
bench term won't fix it either. **TECH = DECK-CONSTRUCTION fix, not policy:** cut energy ~35→13, reclaim ~22
slots for Pokémon (consistency/basics) + draw/search trainers. Test the rebuilt deck vs the field (esp Lucario)
on the matchup instrument BEFORE submit; pre-register. (A 35-energy deck scoring 712 ⇒ soft field ⇒ a consistent
build should climb.) This is the concrete next build.
- **Field ratio template (from pulled decklists):** good decks run **~13 energy / ~28-34 trainer / ~17-20 Pokémon**
  (Lucario 19/13/28, Dragapult 21/8/33, Grimmsnarl 17/14/29). Ours: 10/35/15 — half the trainer engine, 2.5x the
  energy. KEY realization: our "sample deck" is the competition's AUTO-GENERATED STARTER deck (Ten Uchikawa runs
  the identical 34-energy Abomasnow list) — untuned by construction. **Rebuild plan (data-grounded): GRAFT a
  proven field trainer engine** (draw/search trainers are deck-agnostic; copy a top deck's ~28 trainers + ~13
  energy) onto the Snover→Mega Abomasnow ex attacker line. No from-scratch guessing — copy what wins on the ladder.
  Then gate on the matchup instrument (vs Lucario esp.) + pre-register before submit. Card IDs available in the
  pulled replays (every opponent's exact 60).

**GAMES-003 — rebuilt deck: construction fix CONFIRMED, self-play still can't judge the ladder (2026-06-19).**
gygax (via /compose `deck-rebuild-1`, valid_run) rebuilt Abomasnow → **13 Pokémon / 34 Trainer / 13 Energy**
(`.cabt-spike/games/deck_rebuilt.csv`): cut energy 35→13, grafted a proven draw/search engine (Mega Signal,
Poké Pad, Dusk Ball, Ultra Ball, Cheren, Carmine, Lillie's Determination, Waitress) onto Snover→Mega Abomasnow
ex + Hero's Cape ACE (450-HP wall). gygax FALSIFIED my "missing middle stage" guess (evolves direct from
Snover) + showed Lucario is NOT a weakness loss (Abomasnow weak to {M}, Lucario is {F} → we survive Mega Brave
270 into 350 HP). Container test (heuristic constant, vs the REAL extracted Lucario decklist, N=80):
- **OUR_AVG_MAX_BENCH 1.0 → 3.5** — the construction fix WORKS; the root-cause board failure is fixed.
- **Win-rate OLD 0.588 [0.48,0.69] vs REBUILT 0.525 [0.42,0.63] — indistinguishable, and BLIND:** OLD scores
  0.588 vs our-heuristic-piloting-Lucario yet **0.33 on the LADDER** vs real Lucario pilots. Self-play can't run
  the field's actual agents → it CANNOT validate the Lucario matchup. The recurring structural lesson.
- **VERDICT:** the rebuild is a principled, LOW-DOWNSIDE fix of our BEST deck (712) — same attackers/identity,
  consistency repaired, board now establishes. Self-play can't confirm ladder value (we can't pilot the real
  field locally); the ladder is the only judge. Unlike the monofighting swap (a worse deck), this is our good
  deck fixed → submit-as-pre-registered-bet is rational. Pending: operator's submit call.

**GAMES-004 — the rebuild ALSO failed: 2-for-2 falsified deck bets (2026-06-19).** Rebuilt deck (sub
53858250) scored **225.2** vs v4 starter **719.1** — FALSIFIED (p=0.55 → Brier 0.302). Autopsy (12 games, 2-10):
the board fix HELD on the real ladder (**bench 4-5 EVERY game**, vs the old deck's 0-1) — so BENCHING WAS NOT
THE BOTTLENECK; the GAMES-002 diagnosis was WRONG. Leading hypothesis: cutting energy 35→13 STARVED Mega
Abomasnow's attacks (the 35 energy was LOAD-BEARING for this slow {W} wall, not a bug) and/or the heuristic
can't pilot a 34-trainer engine.
- **Calibration record (logged bets): 2 resolved, BOTH falsified, BOTH overconfident** — monofighting p=0.62→
  Brier 0.384; rebuild p=0.55→Brier 0.302. We are MISCALIBRATED-HIGH on deck changes: every self-play-grounded
  deck "improvement" LOST on the ladder.
- **THE HARD LESSON:** the untouched 35-energy v4 STARTER (719) is our best by ~3x for reasons we do NOT
  understand, and BOTH principled "improvements" made it ~3x worse. Self-play/container testing misled us into
  TWO bad submissions. The ladder is the ONLY judge; we keep betting against it and losing. STOP changing the
  deck on self-play confidence. To improve we'd need to test vs the REAL field BEFORE submitting — still unsolved
  (self-play can't pilot the field; replays are finished games, not playable opponents). v5 was correctly HELD
  (the gate refused it; it'd likely have failed the same way). The DISCIPLINE held — we pre-registered both,
  recorded both losses honestly, and now KNOW our deck-confidence runs hot. That is the (painful) value.
- **ACTION:** restore v4 (719) as the active agent; treat the deck as a black box that WORKS until we have a real
  field test. Stop spending submissions on self-play-confident deck changes.

**GAMES-005 — can we test vs the real field before submitting? Investigated: NO (2026-06-19).** Every avenue
checked: (1) opponent agent CODE — private, not downloadable; their episode LOGS are EMPTY (timing only, no
stdout). (2) cabt env reference agents — only `random` + `first` (weak, like greedy). (3) episode replays —
finished games; can't replay our agent into them interactively. **CONCLUSION: no local test captures the real
field — the field's edge is PILOT SKILL (top ~1364 vs our 719), private + far stronger than ANY local pilot we
have (heuristic/PIMC/random/first).** Proof it's hopeless, not unexplored: the rebuilt deck beat greedy 0.95
locally (it CAN close games) yet scored 225 on the ladder — the whole gap is pilot skill no local opponent
simulates. **The LADDER is structurally the ONLY field test.** Reframed strategy: (a) STOP self-play pre-filtering
(anti-signal — 0-for-2, both overconfident); local tests are valid ONLY for legality + does-it-function, never
strength. (b) Use the ladder AS the experiment loop (one variable → pre-register → submit → read → iterate;
~2 months to deadline). (c) UNDERSTAND v4's black box (why the 35-energy starter wins) BEFORE any more changes —
we've been wrong twice about this deck. v4 (719) left as the entry; ladder untouched per operator.

**GAMES-006 — WHY v4 wins: it's BOT-FRIENDLY, not well-built (2026-06-19).** Investigated v4's winning lines.
Ruled out BOTH prior diagnoses: (a) bench — v4 WINS with low bench (1-2); the rebuilt deck LOST with full bench
(4-5). Benching was a red herring. (b) energy-starvation — the rebuilt deck's wall got PLENTY of energy (2-8,
even MORE than v4's 2-6); not starved. Same heuristic, both decks field a FUELED 350-HP Mega Abomasnow ex wall
— yet the SIMPLE deck (35E/15T) WINS and the COMPLEX deck (13E/34T) LOSES. **THE ANSWER: the 35-energy starter
is BOT-FRIENDLY** — almost no decisions (draw energy → attach to the wall → attack), so our crude type-scoring
heuristic can't misplay it + the 350-HP wall grinds the field down. Our "improvements" added a 34-trainer
draw/search engine that is HUMAN-optimal but BOT-HOSTILE: 34 cards of sequencing the crude pilot fumbles. We
made the deck smarter and the PILOT worse at it. The binding constraint was never the deck — it's the PILOT's
(low) skill; the starter is matched to it.
- **META-LESSON (most important finding of the whole arc):** we've been CONFIDENTLY WRONG 4× — monofighting,
  the bench diagnosis, the energy diagnosis, the consistency rebuild. Every plausible model got falsified by the
  ladder. Our cabt instincts (consistency good, bench good, cut energy) are ANTI-CORRELATED with what wins here.
  The only things that held: the working black box (v4=719) + the discipline that caught every error
  (pre-registration, the gate, the ladder). DEFER to the black box; distrust our models; the ladder is truth.
- **If we ever change v4: keep it SIMPLE (bot-friendly), ONE variable, pre-register, ladder-test.** A
  consistency/engine "upgrade" is the wrong instinct for a crude bot. A better PILOT (heuristic_v5-class) is the
  prerequisite for a more complex deck — pilot first, deck second.

**GAMES-007 — pilot-first: heuristic_v5 SHIPPED (2026-06-19).** Acting on GAMES-006 (the PILOT, not the deck, is
the lever): wired `heuristic_v5` (the 6-term board-aware scorer — ko/development/energy/pivot/attack-quality/
tempo) as the agent's SHIPPED default (`agent.py`; `CABT_POLICY=v4`/`pimc` are escape hatches), on v4's
UNCHANGED bot-friendly deck — a clean ONE-VARIABLE ladder bet (pilot, same deck). Built via the implement↔review
pair: FAGAN caught a CRITICAL — the submission package was missing `heuristic_v5.py` + `cards_v5.py`, so it would
have silently shipped worse-than-greedy while looking like v5 (fixed; package now carries v5's full closure).
does-it-run verified (legal moves on v4's deck, container; win-rate NOT read as signal). Pre-registered
`heuristic-v5-pilot-on-v4-deck` **p=0.40** (humble — board-awareness has real merit but we're 0-for-2 +
miscalibrated-high, the bot-friendly lesson warns added complexity may hurt the simple deck, self-play is
anti-signal). Submitted **sub 53859930** (PENDING). Resolves vs v4 (719) when it scores. v4 stays our best
regardless. The 7th logged bet; the LADDER is the only judge.

**GAMES-008 — v5 pilot FALSIFIED, but calibration is SHARPENING (2026-06-19).** v5 pilot (sub 53859930) = 563.2
vs v4 (719) — FALSIFIED (p=0.40 → Brier 0.160). v5 is COMPETITIVE (mid-field, NOT a collapse like the deck
changes at 205-225) but the board-aware 6-term scorer is ~156 Elo WORSE than v4's crude type-only pilot. The
bot-friendly lesson holds a THIRD time: added complexity hurts in the PILOT too. **0-for-3 on improving v4.**
- **CALIBRATION IS THE REAL WIN:** monofighting p=0.62→Brier 0.384; rebuild p=0.55→0.302; v5 p=0.40→0.160. Three
  falsified bets, but the p's DESCENDED (0.62→0.55→0.40) toward the truth (our changes lose) and the Brier
  HALVED. The discipline works — we're learning our true (low/negative) edge over v4.
- **ROBUST META-LESSON:** v4 (719) is a hard local optimum; EVERY sophistication tried (2 decks, 1 pilot) made it
  worse. Our instincts (better deck, smarter pilot) are anti-correlated with winning here. v4's crude simplicity
  is genuinely strong. RESPECT IT.
- **If we keep going, the bot-friendly principle says add the MINIMUM, not the maximum** — v5 bundled 6 terms;
  maybe ONE helps and five hurt. A v4 + ONE targeted term might beat v4 where full-v5 doesn't (still a ladder-only
  bet; self-play is blind). Otherwise: accept v4 (719) as the entry — our changes have been thoroughly shown not
  to help, on a clean pre-registered record.

**GAMES-009 — pilot-first one-term minimal (v6) SHIPPED (2026-06-19).** After v5 (6 terms) lost (GAMES-008),
applied the bot-friendly principle: add the MINIMUM. gygax picked the single term = **energy_economy_term**
(de-randomizes v4's most frequent decision — which Pokemon to fuel on ATTACH, which v4 breaks by LIST INDEX;
ATTACH-only → lowest blast radius; rejected development [bench red herring], attack_quality [redundant with v4's
0.1*dmg], ko/pivot/tempo). v6 = v4's EXACT base + ONE `_safe`-wrapped reused v5 term (`src/cabt/heuristic_v6.py`).
**gygax's wash-gate, honored:** a behavioral A/B (does-it-DIFFER, NOT strength — self-play win-rate is anti-signal)
showed v6 picks differently than v4 on **21.7%** of ATTACH decisions (50/230) → a REAL intervention, worth a slot
(NOT the no-op wash gygax feared). Explicit package import gate → no silent fallback (the FAGAN-F1 risk, handled
mechanically). Submitted **sub 53861711** (PENDING). v6 IS the energy-target-attach intervention → it RESOLVES the
standing `heuristic-v5-energy-target-attach` forecast (**p=0.40**, logged BLIND 06-17) when it scores; gygax's
independent p=0.30 corroborates the humble direction. v4 (719) stays best regardless. The likely outcome is a
WASH (35-energy abundance mutes the term) — this tests whether ANY single targeted term can move v4.

**GAMES-010 — v6 FALSIFIED + the FIELD confirms v4 is PILOT-CAPPED (consilience) (2026-06-19).** v6 = v4 +
energy_economy_term (sub 53861711) = 482.6 (7 games, early) vs v4 719 — FALSIFIED (p=0.40 → Brier 0.16).
**STRIKING (provisional, small-N):** v6 (482) < v5 (568) < v4 (719) — the SINGLE term alone is WORSE than the
full 6-term bundle AND zero terms. energy_economy_term is actively harmful; v5's other 5 terms MASKED it; v4's
ARBITRARY index-0 energy attach beats "principled" targeting. The behavioral A/B (21.7% divergence) correctly
flagged a real intervention; the ladder confirmed the divergent picks are net-WORSE.
- **POISONED-WELL VINDICATED:** gygax's EXPERT "lowest-risk" pick was the single MOST harmful term. Even expert
  priors are anti-correlated here. Calibration: 4 bets, all falsified, recent two Brier 0.16 (well-calibrated).
- **FIELD-SOURCED MINE (the methodology upgrade, executed):** of 13 unique decks that BEAT v4, energy
  min/median/max = 5/13/34; ~10 of 13 are COMPLEX (median 13E, ~30 trainers) = engine decks our crude pilot
  CANNOT run (the rebuild proved trainer-heavy → fumble → 225). The 3 bot-friendly v4-beaters are near-mirrors
  (Snover/Abomasnow ~34E = variance) or marginal (Dwebble 21E/31T). NO clean copyable upgrade for our pilot.
- **CONSILIENCE (convergence from the strongest independent angle):** the field-data analysis CONFIRMS the
  4-prior-bet conclusion — v4 is a PILOT-CAPPED local optimum. BOTH angles (our priors AND the field's revealed
  winners) converge: v4 (719) is our genuine ceiling given our methods.
- **VERDICT: ACCEPT v4 as the entry** — now triangulated, not a comfortable cul-de-sac. The real product was the
  METHODOLOGY (pre-registration + calibration + consilience), not the rank. 0-for-4 at winning, ~3-for-4 at
  KNOWING our edge — the rarer, compounding skill. To climb would need a qualitatively better PILOT (the proven
  binding constraint), which our methods can't produce; revisit only if that changes.

**GAMES-011 — field-imitation feasibility: decisive GO (2026-06-19).** Operator surfaced the public dataset
`kaggle/pokemon-tcg-ai-battle-episodes-index` → daily TOP-episode datasets (per-episode JSON, individually
downloadable; ~21GB/day but SAMPLE-able, no bulk needed). Audit (6 sampled top episodes, 06-18):
- **TOP-TIER play accessible** — daily top_avg 1024→1327 (06-16→18), median 927 — vs our v4's 719. A real
  ceiling-LIFT target, not mid-field.
- **Imitation data extractable + ABUNDANT** — winner (observation→action) pairs: 298 from 6 games, 263 real
  choices (>1 option) = ~43 learnable decisions/game → one daily dataset (~6500 games) ≈ **280k state→move
  samples/day.** Enough to train a real policy on a SINGLE day.
- **1300-tier META (n=12, small):** Mega Lucario ex + Dwebble/Crustle dominate.
- **THE KEY:** imitating top winners is the FIRST local signal grounded in real ladder success (not self-play
  noise, not our anti-correlated priors). This is the qualitatively-different PILOT the binding-constraint
  analysis demanded — it SUPERSEDES the "accept v4 / can't build a better pilot" verdict. Viable path:
  behavioral cloning from top-tier play. Next: /kickoff the imitation-pilot build (extract → features → policy →
  ship → ladder, pre-registered) in a FRESH session — a real ML effort, not a marathon-tail tweak. Sample data
  in `.cabt-spike/top/`.

**GAMES-012 — imitation learnability spike + the ECHELON ghost arena: deck-strength ⊥ pilot-learnability (2026-06-19).**
Ran the imitation bet as a verify-before-spend LEARNABILITY spike (NOT a build) — `.cabt-spike/imitation_spike.py`,
256 top-tier episodes, CSV-backed features (the cg engine is a Linux-only native lib → can't run offline on Mac;
EN_Card_Data.csv carries stage/hp/type/weak/retreat/cost/dmg), hand-resolved card identity (`hand[opt.index].id` —
options carry only a hand index, NOT cardId; the first cut missed this and read all card features as 0), softmax-
over-candidates linear ranker, held-out by GAME, 8-seed CV.
- **Learnability is archetype-dependent (held-out top-1 of predicting experts):** LUCARIO learned 0.330 vs v4 0.273,
  **lift +0.057±0.021, 8/8 splits** — a real signal (v4 is WEAK on aggro). DWEBBLE/CRUSTLE learned 0.582 vs v4 0.571,
  **lift +0.011±0.026 (flat)** — v4 already pilots the grindy engine deck at ~expert level. Per-card-id one-hot
  OVERFITS (hurts held-out) both → the signal lives in board-DELTA features, not card memorization.
- **The metacog reframe (operator):** don't polish a fake signal (self-play / a local proxy we've learned not to
  trust); CHANGE the signal regime. Built **Echelon v0 — the ghost arena** (`.cabt-spike/echelon/settle.py`):
  settle the 254 real top-tier matches we already hold against ground truth → player Elo + the archetype matchup
  matrix. No engine, no Docker. (A coliseum seeded with greedy clustered our pilots at 0.5 — GAMES-008; field
  QUALITY is the whole ballgame, so seed it with the REAL meta / imitation clones, not greedy.)
- **THE REAL META (settled, 754 matches / 756 episodes):** a ROCK-PAPER-SCISSORS triangle — Dwebble/Crustle beats
  Lucario (0.73, N=154), Lucario beats Alakazam (0.62, N=16), **Alakazam beats Dwebble (0.80, N=66)**. Dwebble/Crustle
  is the most-PLAYED (868 share) and beats most of the field (Lucario/Dragapult/Abomasnow 0.73–0.81), but Alakazam
  (share 121, wr 0.60, top pilotElo ~1673) HARD-COUNTERS it. Lucario = meta-food (0.40 wr). Artifact:
  `.cabt-spike/echelon/meta.json`. **Caveat for the fired Dwebble bet:** Alakazam (~16% of the field) is its
  kryptonite (0.20) — a known drag already folded into the humble p=0.45.
- **KEY FINDING — deck-strength ⊥ pilot-learnability (two orthogonal axes I'd been conflating):** Lucario = learnable
  pilot on a LOSING deck (a perfect pilot still drowns 0.19 vs Dwebble); Dwebble/Crustle = winning deck whose pilot
  is ALREADY adequate (no learned lift). The narrow top-1 signal alone would have walked us into cloning a losing
  deck — **the ghost arena corrected the live Lucario rec.** Consilience: you need a learnable pilot ON a winning deck.
- **NEW LEADING HYPOTHESIS (spike × arena, neither reaches it alone):** copy a top **Dwebble/Crustle** decklist +
  keep the proven **v4-class bot-friendly pilot** (which the spike shows plays it ~57% expert-aligned). Winning deck +
  already-adequate pilot, NO ML. Counter-weight (the scar): every prior DECK swap collapsed (mono 205, rebuild 225)
  because the new deck was bot-HOSTILE (trainer engines our crude pilot fumbles); Dwebble/Crustle has a Cook/Lillie's/
  Waitress engine. BUT the 57% agreement is direct evidence the pilot can handle it → first bet with evidence on BOTH
  sides of the deck-vs-pilot tension. Ladder-resolvable, pre-register humbly. v4 (719) stays the standing entry.
- **Coliseum roadmap:** v0 ghost arena (DONE) → v1 live Docker matches (engine x86-64 via Docker bridge, cabt-viewer
  pattern) with an imitation-CLONE roster as the field, VALIDATED against the 5 ladder points (v4 719 > v5 569 > v6
  540) where the greedy-field arena failed (0.5 cluster) → v2 research-team submissions + cabt-viewer progression view.
- **SHIPPED the Dwebble/Crustle bet — sub 53868523 (PENDING, 2026-06-20).** v4 type-only pilot (CABT_POLICY=v4,
  byte-identical to the 719 pilot) on the converged Dwebble/Crustle deck (`.cabt-spike/sub_dwebble_v4/`, deck from
  `echelon/deck_dwebble_crustle.csv`). Pre-registered `deck-dwebble-crustle-with-v4-pilot` **p=0.45** (registry head
  ec253962, valid=7). No-engine smoke PASS (package complete, deck-selection returns the exact list). Resolves vs v4
  (719) when it scores. v4 stays the standing entry. (Ladder settle note: v6 finalized 539.8, v5 569.2 — both < v4.)
- **COLISEUM v1 — engine runs LOCALLY (proof-of-life, 2026-06-20).** `.cabt-spike/echelon/arena_match.py` drives the
  cg.game API inside `docker run --platform linux/amd64 python:3.12` (x86-64 engine via qemu on the ARM Mac). One
  match in **0.6s** (v4 beat greedy, sanity ✓) — fast enough for a local coliseum, no Linux box needed. UNBLOCKS v1.
  NEXT (the validation gate): round-robin v4/v5/v6 (same Abomasnow deck, pure pilot) vs a DIVERSE clone field (the
  real archetype decks piloted by v4) → does the arena reproduce v4>v5>v6 (719/569/540) where the greedy-field arena
  clustered at 0.5 (GAMES-008)? If yes = a trustworthy fast signal that escapes the 5-bets/day prison.

**GAMES-013 — the VALIDATION GATE (pre-spike for the coliseum): arena is NOT yet a ladder-replacement (2026-06-20).**
Operator invoked /simstim to build a submission coliseum for the research team, BUT flagged "pre-spike it" — validate
the arena can replace the ladder BEFORE pouring a planning cycle into a "replaces-the-ladder" platform. Ran it
(`.cabt-spike/echelon/validate_arena.py`, in the amd64 Docker engine, 240 matches/13s): each pilot (v4/v5/v6, same
Abomasnow deck, pure-pilot) vs greedy + the diverse meta-field (Dwebble/Lucario/Alakazam, v4-piloted).
- **RESULT (honest, not the crude auto-label):** the diverse field ranked **v4 first (0.400) > v5=v6 (0.317)** —
  CORRECT direction, reproducing the ladder's top, where the GREEDY field TIED v4=v5=0.60 (mis-rank). So a real-meta
  field IS more ladder-faithful than greedy. BUT the separation is 0.08 at N=20 (~60 field-games/pilot, ~1.3 SE) =
  WITHIN NOISE; v5/v6 tied (their ladder gap is small); and the Dwebble column is ~0.00 for ALL pilots (Abomasnow
  loses to Dwebble deck-deterministically — zero pilot signal). 
- **WHY it can't separate confidently: the FIELD IS TOO WEAK.** It's v4-piloted decks — too weak + self-correlated to
  punish pilot mistakes the way a 1300-Elo field does. Field QUALITY is the whole ballgame (consilient with GAMES-008's
  0.5 cluster). To become a ladder-proxy the field needs STRONGER opponents (imitation clones / stronger pilots) + more N.
- **VERDICT: the arena is NOT yet a trustworthy ladder-replacement — directionally promising, underpowered, weak field.**
  The pre-spike did its job: it STOPPED us building a "replaces-the-ladder" platform on an unvalidated premise.
- **REFRAME for the coliseum:** the submission platform is the MECHANISM that strengthens the field (more diverse strong
  submissions = stronger field = better signal). So build it as "a battleground that BOOTSTRAPS a calibration signal"
  (useful from day 1 for rough ranking + the ghost-arena meta), NOT "a drop-in ladder replacement (today)." Fork held
  for the operator: (a) strengthen field first (clone roster) + re-validate → then platform; (b) build platform now with
  the honest bootstrap framing; (c) higher-N re-validate first. Stale simstim state (simstim-20260614, unrelated) +
  Flatline degraded (no ANTHROPIC_API_KEY) are practical gates IF we commit the cycle.
- **DIRECTION (operator, 2026-06-20):** sequence = STRENGTHEN THE FIELD FIRST (2-3 imitation clones as stronger
  opponents) → re-validate → THEN the platform PRD. MVP = research team only. **Guiding principle (load-bearing):
  calibrate against opponents that MIRROR REALITY as closely as possible — the best opponent is other real users /
  their agents, not synthetic bots. "Reality is the biggest test; our job is to simulate it as closely as possible."**
  → the clones are a SEED; the real field = team submissions. So the field-strengthening IS the minimal real-submission
  loop (research-team-only), seeded with clones + the ghost-arena meta. Synthetic-field validation (GAMES-013) already
  showed bots barely separate pilots — vindicating "real opponents, not bots."
- **FLATLINE PROVIDERS (operator wants Cursor-Claude + Codex-GPT5.5):** both CLI tools ARE on the machine (codex-cli
  0.139.0, cursor-agent at ~/.local/bin), but Flatline routes through cheval's API adapters (anthropic/openai/google —
  key-based; OPENAI_API_KEY set, ANTHROPIC_API_KEY unset = DEGRADED). cheval has NO codex/cursor CLI backend → wiring
  them is a FRAMEWORK pass in the loa repo (`.claude/adapters/loa_cheval/` = System Zone here, off-limits to in-project
  edits; the headless-CLI-adapters live in ~/Documents/GitHub/loa per memory). NOT on the critical path yet (field-first
  means Flatline isn't needed until the PRD review phases) → defer the CLI-adapter wiring to when we commit the cycle;
  quick fallback if needed sooner = set ANTHROPIC_API_KEY (raw). Did NOT change model routing (no-latitude).

**GAMES-014 — CLONE ROSTER built (via /compose, proven valid_run) → synthetic field-strengthening is a DEAD END (2026-06-20).**
Built the clone roster via /compose code-implement-and-review (general-purpose → FAGAN), terminal gate **valid_run**
(run_id clone-roster-20260619-91e212, envelope_digest sha256:8d83d025). 3 files in `.cabt-spike/echelon/`: `train_clones.py`
(reuses imitation_spike's featurizer/ranker VERBATIM — bit-parity proven over 86,272 options), `clone_agent.py`
(pure-python serve, explicit no-silent-fallback load gate), `validate_arena_clones.py` (the clone-field gate). FAGAN
earned its keep: caught the alakazam negative-lift honesty caveat + 2 MINOR hardening (mu/sd single-source, sd-zero
guard — deferred, latent not active); the Docker engine RUN caught a `KeyError` (CLONES keyed by FIELD-key not arch_slug)
the stub-smoke missed — fixed (1 line).
- **The clones are WEAK imitators:** held-out top-1 over v4 — lucario +0.032, dwebble +0.012, **alakazam −0.007** (imitates
  its archetype WORSE than v4's hand priors). Marginal at best.
- **THE RESULT (the clone-field gate, Docker, N=20):** the clone-field spread (0.10) is only marginally wider than the
  v4-piloted field (0.08) AND it **MIS-RANKS** the pilots: v6 (0.500) > v4 (0.433) > v5 (0.400) — the ladder truth is
  v4 > v5 > v6 (719/569/540). The ordering is within noise (~1.1 SE at N=20). So even a field of imitation clones of the
  REAL meta CANNOT reproduce the ladder.
- **DECISIVE CONCLUSION:** synthetic field-strengthening (even reality-mirroring imitation clones) does NOT yield a
  trustworthy local ladder-proxy. Consilient with GAMES-013 (field too weak) + GAMES-008 (greedy 0.5 cluster) + the
  operator's principle: **you cannot fake the ladder with synthetic opponents, even good ones — the REAL field (real
  participants) is the only path.** Field-strengthening-via-clones is CLOSED.
- **STRATEGIC PIVOT:** the path to a trustworthy local signal is the REAL-PARTICIPANT platform (research-team submissions
  = the real diverse field), NOT synthetic bots. The clones survive only as weak sparring/variety opponents, not a proxy.
  Next: the real-participant coliseum (simstim), once the tree is committed + /update-loa lands the headless framework.
  Standing: Dwebble bet 53868523 still PENDING.

**GAMES-015 — Dwebble bet RESOLVED (HELD, new PB) + the COLISEUM instrument built (2026-06-20).**
- **DWEBBLE RESOLVED → HELD.** sub 53868523 = **807.5** (COMPLETE) vs v4 baseline 719.1 — the **first deck bet to HIT**
  and the first forward `held`. Logged to `cabt-calibration-logged.jsonl` (5th forward bet): outcome=held, p=0.45,
  **Brier 0.3025**, margin +88.4 Elo → ≈0.62 implied H2H (effect=small). Forward track record now **1-held / 4-falsified,
  mean Brier ≈0.26.** CALIBRATION LESSON: the **lowest-confidence** bet won — the two deck bets we were *most* sure of
  (mono 0.62, rebuild 0.55) collapsed; Dwebble (cut to 0.45, gun-shy after 0-for-2) hit. What flipped it was GROUNDING
  QUALITY (converged meta-king list + measured 0.57 pilot-agreement), not gut. → weight grounding evidence over
  streak-driven gut. (NOT the general "deck is the lever" — that stays falsified for weak pilots; Dwebble worked because
  bot-friendly deck + pilot already matched its experts.)
- **OPERATOR DECISION (2026-06-20):** "simstim the live coliseum with our internal team" → resolved the fork to
  **BUILD THE INSTRUMENT NOW** (not the /update-loa re-baseline — the arena engine doesn't need it; rebaseline deferred).
- **COLISEUM BUILT (`.cabt-spike/coliseum/`)** — `coliseum.py` + `roster.json` + `README.md`. A round-robin tournament
  over `(pilot, deck)` entrants in the REAL `cg` engine: Bradley-Terry Elo leaderboard + win-matrix + a `--replay`
  ride-along (simstim) per-decision trace + a **field-trust meter** (SYNTHETIC→BOOTSTRAP→TRUSTWORTHY by real-owner count).
  Intake = a Kaggle-shaped `bundle:` dir (`agent(obs)->list[int]` + deck.csv) → a teammate adds one roster line.
  **VALID RUN** (Docker amd64): 8 internal entrants, N=2 → **112 matches in 6s, 0 non-terminating**; replay mode proven.
- **CONSILIENCE (the instrument's first finding):** coliseum independently ranks **champion-dwebble #1** (Elo 1246, 89%)
  — MATCHES the ladder PB (807.5). BUT it mis-ranks v5>v4 (ladder: v4>v5) and puts a CLONE at #2 → field-trust meter
  correctly fires **SYNTHETIC, do-not-trust-the-fine-ranking**, consilient with GAMES-014. The deck lever is large enough
  to survive a weak field; the pilot ranking is not. The instrument is honest about its own limits on run 1.
- **STANDING / NEXT:** coliseum is trustworthy only once **≥3 real teammate agents** enter (until then: a sparring sandbox
  + a deck-lever confirmer). 4 ladder submissions left in today's budget. Coliseum + calibration ledger uncommitted (tree
  was clean @ c94b8cdc). Next bet (pacing): #2 meta-king deck (Dragapult, the matchup matrix's runner-up) OR a careful
  Dwebble-deck tune — the calibration says trust bot-friendly-deck + pilot-already-matches, doubt pilot-complexity bets.

**GAMES-016 — the COLISEUM ↔ cabt-viewer integration sensed + the keystone seam proven (2026-06-20).**
- **THE WEBSITE = `cabt-viewer` (github.com/charlielockyer-rice/cabt-viewer)**, NOT observatory. A teammate's Svelte 5
  replay viewer + Docker engine bridge, Railway-ready (`start`=sirv on $PORT), loads replay JSON via
  `?view=replay&replayUrl=…`. Cloned to `~/Documents/GitHub/cabt-viewer`. **observatory = a view for loa-laplas** (gated
  agentic workflow) — do NOT conflate or share its design system.
- **OPERATOR REFRAMES (2026-06-20):** (a) rails = a **live Railway service + CLI/agent-skill** teammates "just send" their
  Kaggle bundle to (NOT a PR — lower friction, hosted). (b) Home = a **throwaway experiment/gadget folder**; cohesive only
  at the primitive/methodology level (research loop, cg-engine harness, calibration, replay format), FREE at the UI level
  — "learning across many fields is the point." Coliseum stays in `.cabt-spike/coliseum/`, not the cohesive zones.
- **THE REALNESS-LADDER THESIS (operator convergence):** grounding/metacognition requires being grounded in reality;
  synthetic < teammate-agents < live-ladder. The least-confident Dwebble bet winning *because of grounding* IS the lab's
  own creed (map≠territory / agents-reason-substrate-verifies / "submit what's calibrated, not what felt strong") scoring a point.
- **BUILT + PROVEN (valid Docker runs), all in `.cabt-spike/coliseum/`:**
  - `coliseum.py` — round-robin in the real `cg` engine · Bradley-Terry Elo · win-matrix · `--replay` ride-along ·
    **field-trust meter** (SYNTHETIC→BOOTSTRAP→TRUSTWORTHY). First run: ranks champion-dwebble #1 (=ladder PB), mis-ranks
    v4/v5/v6 + clone#2 → meter correctly = SYNTHETIC.
  - `submit.py` — Kaggle `submission.tar.gz` → **isolated-subprocess** validation (bundle's own cabt/, our engine; the
    same isolation Kaggle uses) → roster register. Proven on the Dwebble tar (legal, 0 crashes). NOTE: foreign agents play
    the **deck-as-first-action** protocol, so the FULL round-robin over foreign bundles needs a subprocess match-coordinator
    (the rails) — that's why the demo scored 0% vs the floor (protocol mismatch, not weakness).
  - `emit_replay.py` — coliseum match → **schema-valid cabt-viewer replay** (cards/attacks from our own `cg.api`). Proven:
    champion-dwebble vs greedy → 96 steps, winner correct, 1.5MB; structurally matches their `cabt-match.json` (only delta:
    optional `lookingCount`, engine-version, likely non-breaking; pending a visual confirm in the live viewer).
- **THE PATH (sensed):** teammate's Kaggle tar.gz → CLI/skill → **Railway intake service** (isolated validate + coliseum
  run) → emits `leaderboard.json` + per-match cabt-viewer replays → **cabt-viewer displays** (leaderboard + watch the games).
- **NEXT INCREMENT:** the Railway intake service (subprocess match-coordinator for foreign agents) + the `cabt-submit`
  CLI/skill. Deploying live to Railway is an outward action → confirm Railway project/account before deploy. Uncommitted:
  coliseum/ gadget, calibration ledger, NOTES. cabt-viewer cloned (separate repo, untouched).

**GAMES-016 addendum (2026-06-20) — `cabt-submit` CLI built + the faithful-driver decision + Railway grounded.**
- **`cabt-submit` CLI built + proven** (`.cabt-spike/coliseum/cabt-submit`, stdlib-only): `cabt-submit <tar|dir> --name --owner`
  → LOCAL mode = isolated cg-engine validation (wraps submit.py via Docker) + register; `--url` = REMOTE multipart POST to
  the hosted service. Proven: ingested the Dwebble tar as 'alice', registered. (win% still unreliable for full agent()
  bundles — the deck-as-first-action issue below — but legality/no-crash is confirmed.)
- **FAITHFUL-DRIVER DECISION (key):** cabt-viewer's `src/engine/cabt_bridge.py` is ALREADY a correct Kaggle-agent match
  driver — decks pre-given to `battle_start(d0,d1)`, agents use the SEPARATE `search_begin` API internally (no engine
  collision with the match), and it SKIPS `select is None` instead of mis-feeding it (that mis-feed = my 0% demo: the full
  `agent()` returns its 60-card deck on the select=None step, garbage as option-indices). → RIGHT PATH = COMPOSE our
  orchestration (round-robin, Elo, field-trust, calibration = OUR primitives) with THEIR bridge driver; do NOT reinvent the
  protocol. The Railway service should import/mirror cabt_bridge's Session driver.
- **RAILWAY GROUNDED:** authed as soju (underrated@gmail.com), workspace **"the honey jar"**; `finn-cost-of-play` exists,
  NO coliseum/viewer project yet, no railway config in either repo. Deploy = a NEW project (proposed `cabt-coliseum`).
  GATED on operator confirm: project name + topology (viewer-only-first vs viewer+intake-service).

**GAMES-017 — LIVE: cabt-viewer deployed to Railway + a real coliseum match watchable on it (2026-06-20, operator "Go").**
- **LIVE SITE: https://cabt-coliseum-production.up.railway.app** — Railway project `cabt-coliseum` (id 5f1d5b6b-92c5-4226-9231-019103a6ab17,
  workspace "the honey jar", service e983d190, env production). Deployed FROM the local cabt-viewer clone (nixpacks: npm ci →
  `npm run build` vite/svelte → `sirv dist` on $PORT). Built clean locally first (231 modules, dist 1.2MB). Online after ~96s.
- **A real COLISEUM match is on the live site:** staged `emit_replay`'s champion-dwebble-vs-greedy replay into the viewer at
  `public/game-logs/coliseum-demo.json`; served live (HTTP 200, ok=true, 96 steps, 1267 cards, winner champion-dwebble).
  **Watch URL:** `…up.railway.app/?view=replay&replayUrl=/game-logs/coliseum-demo.json`. VERIFIED served + schema-valid;
  PENDING the operator's eyes on whether it RENDERS (the `lookingCount` optional-field caveat — viewer's own samples render regardless).
- **NOTE:** deployed my local clone (NOT pushed to charlielockyer-rice's GitHub). Railway is NOT yet linked to a GitHub repo for
  auto-deploy — redeploys are `railway up` from the clone for now.
- **NEXT (step 4 of the plan):** the INTAKE SERVICE — a SECOND Railway service in `cabt-coliseum` that bundles the cg engine
  (.cabt-spike/dl) + cabt_bridge's faithful driver + submit.py validation; `POST /submit` (cabt-submit --url) → run vs champion
  (or round-robin) → write leaderboard.json + replays the viewer reads. Engine-packaging is the main eng decision (vendor the
  Linux .so + decks + card CSV into the service image).

**GAMES-018 — coliseum UI shipped live: nav + Submit surface + Leaderboard (2026-06-20).**
- Edited the cabt-viewer clone (within its own teal-glass token system — NOT observatory's): upgraded `AppHeader.svelte`
  → a fixed nav bar (brand "CABT COLISEUM" + Play/Replays/Leaderboard + a **Submit agent** CTA); new `SubmitPanel.svelte`
  (`?view=submit`: team framing + the realness-ladder strip + the `cabt-submit` CLI [live] + an upload form [POST to
  VITE_COLISEUM_API/submit, "coming online" until the service deploys]); new `Leaderboard.svelte` (`?view=leaderboard`:
  reads `/leaderboard.json`, Elo table + W-L + watch-replay links + a prominent **field-trust banner**). Wired both into
  App.svelte mirroring the `showPromptGallery` full-screen pattern (additive, board engine untouched).
- Seeded REAL data: `public/leaderboard.json` from the coliseum run (champion-dwebble #1 @ 1246, trust=none/SYNTHETIC),
  and added the coliseum match to `public/game-logs/logs.json` (Replays catalog).
- **Redeployed live** (`railway up --service cabt-coliseum`): https://cabt-coliseum-production.up.railway.app — verified
  leaderboard.json/replay served + new JS bundle hash matches local build. VISUAL render = operator's eyes (headless can't confirm Svelte paint).
- Views: `/?view=submit`, `/?view=leaderboard`, `/?view=replay`. NEXT: the intake service (so the upload form goes live), then
  recruit ≥3 real teammate agents to flip field-trust off SYNTHETIC.

**GAMES-019 — intake service LIVE + viewer wired + ARTISAN padding fix (2026-06-20).**
- **INTAKE SERVICE LIVE: https://coliseum-api-production.up.railway.app** — 2nd Railway service `coliseum-api` (id
  1faa41de) in the cabt-coliseum project. FastAPI (`.cabt-spike/coliseum/service/`: app.py + validate.py + Dockerfile +
  requirements + vendored `engine/` = a copy of .cabt-spike/dl, 3.2MB). `POST /submit` (multipart tar.gz+name+owner) →
  extract → **isolated-subprocess validate in the real cg engine** (the submit.py smoke) → register on leaderboard +
  entrants. Also `GET /health|/leaderboard|/entrants`, CORS=*. Built + TESTED locally in Docker, then deployed + TESTED LIVE:
  submitted the Dwebble tar as owner 'rice' → `✓ legal, 6 smoke matches, 0 crashes` → leaderboard real-owners=1.
- **VIEWER WIRED** (redeploy, new bundle index-ZEn5qc2U.js): set `VITE_COLISEUM_API` on the cabt-coliseum service →
  inlined into the build (verified). Submit form POSTs to the service; Leaderboard.svelte fetches `${API}/leaderboard`
  (falls back to static seed). So the live site's submit + leaderboard are wired to the live service.
- **ARTISAN padding fix:** SubmitPanel upload card was clipped off-screen-right — grid items default `min-width:auto` so the
  nowrap CLI `<code>` blew the track past the 1040 container. Fixed with `.card { min-width: 0 }` (code scrolls inside).
- **CAVEATS (honest):** service `/submit` VALIDATES + REGISTERS only — does NOT yet run the round-robin (entrants show
  "awaiting matches", no Elo). The match-runner (subprocess coordinator: submitted agent in a subprocess vs the in-process
  champion, faithful deck-as-first-action protocol per cabt_bridge) is the next increment. Railway disk is EPHEMERAL (resets
  on redeploy) — add a volume before real use. The live 'rice-dwebble' entry is my test artifact (clears on next redeploy).
- NEXT: (1) the match-runner so submissions get an Elo + a watchable replay; (2) a Railway volume for persistence;
  (3) recruit real teammate agents → field-trust off SYNTHETIC.

**GAMES-020 — Sprint 1 MATCH-RUNNER shipped LIVE + a real faithfulness bug found & fixed (2026-06-20).**
- Formalized via `/sprint-plan` → `sprint-coliseum.md` (4 sprints, match-runner first) + a scoped `/architect` →
  `sdd-coliseum.md` (3 decisions: subprocess-hardened isolation [Railway can't do kernel isolation], single serialized
  worker thread, bare-id replay contract). Operator chose **spike-mode build**.
- BUILT (`.cabt-spike/coliseum/service/`): `sandbox.py` (scrubbed env + setrlimit + privilege-drop-to-nobody + setsid/killpg
  — **fixes the live os.environ secret-leak** to untrusted code), `agent_worker.py` (JSON-line IPC, protected stdout),
  `match_runner.py` (coordinator owns cg; brokers each select to the seat's worker; faithful deck-as-first-action /
  skip-select-None), refactored `app.py` (single `queue.Queue` worker thread → /submit validates fast + enqueues + returns
  <2s; status validated→queued→running→ranked; `GET /replays/{id}`), vendored `cabt/` champion pilot + `champion/` bundle.
- **THE BUG (found by validate-then-distrust):** first run = 0-6, then a v6 MIRROR (champion=v6 vs foreign=v6, identical
  deck+code) = **1-11**, not ~50%. Ruled out obs-fidelity (to_jsonable + JSON faithful), deck (byte-identical), code
  (md5-identical), hash-seed (choose deterministic across procs), latency. ROOT CAUSE = the **in-process-champion vs
  subprocess-foreign ASYMMETRY** (the in-proc champion shares the live cg singleton state with the authoritative match;
  the worker only has the obs). PROVEN: symmetric two-worker mirror = 8-4 (fair) vs in-proc 1-11 (broken).
- **THE FIX (= the SDD's R1 evolution path):** run BOTH agents as symmetric subprocess workers (champion is now a
  `champion/` bundle too); the coordinator runs NEITHER agent in-process. Mirror → 8-4 (~fair); **Dwebble (v6) vs champion
  (v4) → 6-4 local / 5-5 LIVE, winPct 0.5-0.6, elo ~1246-1310, 0 errors** — non-degenerate, faithful, the 0% artifact gone.
- **LIVE + tested** on Railway: `coliseum-api` redeployed (match-runner + security fix), `cabt-coliseum` viewer redeployed
  (new bundle index-BDx4xwU1.js; `Leaderboard.replayHref` now builds an absolute, encodeURIComponent'd `${API}/replays/{id}`
  URL — SDD Decision 3). Live submit → ranked #2 (elo 1246, 5-5) on the board; replay served (216 steps).
- **Sprint 1 ACs MET:** decisive non-0% result · foreign in own process · select-None skipped · bounded match · /submit <2s
  async · seat-swap · replay generated · security env-leak fixed. **Caveats:** still EPHEMERAL disk (Sprint 3 volume);
  seccomp net-block deferred (Sprint 3); the live 'rice-dwebble' is my test entry (clears on next service redeploy).
  Sprints 2-4 (full round-robin Elo, persistence+sandbox-hardening, E2E+onboarding) remain.

**GAMES-021 — Sprint 2 (ranking + live field-trust + XSS) shipped LIVE, spike-mode (2026-06-20).**
- Operator chose **spike-mode for Sprints 2-4** (NOT `/run sprint-plan` — which would've targeted the cycle-053 Corpus
  Engine `sprint.md`, not `sprint-coliseum.md`; I halted + surfaced that targeting hazard before executing).
- BUILT: a **reference field** as symmetric worker bundles (`service/champion` v4 + `service/field/v6` + `service/field/greedy`,
  anchored at coliseum Elos 1246/913/872) + `ranker.py` (rate a submission vs each reference, seat-swapped, anchored-implied
  Elo = anchor + 400·logit(p), averaged — the R5-scoped "fixed reference field", not an O(N²) all-subs round-robin). app.py
  now ranks via `ranker.rank_submission` (field Elo + per-opponent breakdown), recomputes **live field-trust** from the roster
  (SYNTHETIC→BOOTSTRAP→TRUSTWORTHY), and sanitizes name/owner. **XSS (R7):** viewer has NO `{@html}` → Svelte auto-escapes;
  the agent can't inject replay strings (returns only pick indices) → R7 covered by framework + sanitize.
- **LIVE + tested** (coliseum-api redeployed): submit → ranked vs field → Elo 1154, 13-5, rank #3; leaderboard shows live
  **BOOTSTRAP** (1 real owner). Per-opponent breakdown stored. Replay (vs champion) served.
- **REVIEW RIGOR:** dispatched `construct-fagan` (background) on the full service (sandbox/worker/coordinator/ranker/app) —
  security + correctness adversarial pass (the spike-mode substitute for run-mode's audit gate). Findings pending.
- **DEVIATION (honest):** used anchored-implied-Elo vs a fixed reference field, NOT a full Bradley-Terry re-fit (sprint AC
  said "reuse coliseum bradley_terry"). Justified: it's the correct method for incremental rate-vs-anchors + avoids O(N²)
  recompute (R5); the anchors ARE from the coliseum BT run. Full all-subs round-robin = later enhancement.
- NEXT: fold FAGAN findings → close Sprint 2. Sprint 3 = persistence (Railway **VOLUME = outward infra, confirm before
  provisioning**) + sandbox hardening (seccomp net-block needs the Railway-seccomp verification spike) + concurrency (the
  single-worker-thread + _STATE_LOCK already serializes writes — Sprint 3 AC largely pre-met). Then Sprint 4 (E2E + recruit owners).

**GAMES-022 — FAGAN BLOCK → criticals fixed + the match-runner ACTUALLY works now (2026-06-20). The big correction.**
- **FAGAN (adversarial review, 3 CONFIRMED-by-repro) returned BLOCK.** Two findings invalidated prior claims:
  - **F2 (CRITICAL): the match workers never imported the bundle's main.py** — `python <HERE>/agent_worker.py` sets
    sys.path[0]=the SCRIPT dir, NOT cwd/bundle → `from main import agent` failed → `_agent=None` → EVERY agent silently
    floored. So ALL Sprint-1/2 matches were **floor-vs-floor**, and the "mirror ≈ 50%" + "fixed the asymmetry" validations
    were **FALSE POSITIVES** (floor-vs-floor is trivially ~50%). The earlier 1-11 was real-in-proc-champion vs floored-worker.
    My symmetric-worker "fix" had masked F2 by flooring BOTH sides. **The review caught what my own validation could not.**
  - **F1 (CRITICAL): live root RCE** — `tarfile.extractall` default on 3.12 = fully_trusted → path-traversal + symlink →
    arbitrary write as root, BEFORE any sandbox, on the live public endpoint.
- **RESPONSE:** took `coliseum-api` DOWN immediately (closed the live RCE), then fixed F1 (`_safe_extract`: pre-scan reject
  traversal/abs/symlink/device + caps + `filter='data'`), F2 (agent_worker `sys.path.insert(0, os.getcwd())` + surface
  `_import_error` not silent floor), F3 (deadline-bounded binary os.read loop — select-ready≠full-line), F4 (killpg reap +
  close pipes), F5 (stderr=DEVNULL), F6 (1MB IPC cap), F7 (unconditional respawn after timeout — desync), F8 (sync /submit
  endpoint → threadpool, unblocks event loop), F9 (supervised worker thread), F10 (sanitize untrusted pick before
  battle_select), F12 (generic error message). Binary IPC throughout.
- **RE-VALIDATED BY REPRODUCTION (the moment of truth):** champion(v4) vs greedy = **16-0** (the discriminating strong-vs-weak
  test — floor-vs-floor would be ~8-8 → agents now REALLY play); mirror v4-vs-v4 = 7-5 (fair); ranker per-opponent SENSIBLE
  (Dwebble-v6 sub beats ref-v6 6-0 [deck edge], crushes greedy 6-0, even vs v4-champion 3-3); evil traversal+symlink tars
  REJECTED (live), nothing escaped. Redeployed hardened; live submit → ranked, F1 rejection confirmed live.
- **DEFERRED (acceptable for internal-team; note before any public/volume traffic):** F11 (no auth/rate-limit/tar-cleanup;
  sid-collision can clobber a slot), F13 (field-trust 'real owner' = unverified free-text → spoofable; needs auth), F14
  (draw-code handling, speculative), F15 (per-uid RLIMIT_NPROC, validate-timeout pgid-kill, CORS '*', file ctx-managers).
- **LESSON:** distrust-then-verify with an adversarial reviewer is load-bearing — my green validations were false positives
  for ~2 sprints; FAGAN's reproduction-grade review is what surfaced it. Sprints 1-2 are NOW genuinely working + safe.

**GAMES-023 — replay-404 bug fixed + Sprint 3 (persistence + sandbox) shipped LIVE (2026-06-20).**
- **BUG (operator-reported): leaderboard "watch" → 404** on `/replays/coliseum-demo.json`. Root cause: the viewer routes
  ALL replay links to `${API}/replays/${replayField}`, but the seed champion row's `replay` was a viewer-LOCAL filename
  ("coliseum-demo.json") that was never on the API (+ `_safe` mangles dots). Compounded: the Railway volume CAPTURED the
  pre-fix /data, so a fresh seed wouldn't overwrite the stale field. FIX: baked the demo replay into the service
  (`replays_seed/coliseum-demo.json`, boot-seeded into /data/replays) + an idempotent boot MIGRATION (strip `.json` from
  replay fields → bare id). Verified live: `/replays/coliseum-demo → 200`, champion.replay → `coliseum-demo`, watch link resolves.
- **SPRINT 3 (persistence + hardening) — DONE + verified:**
  - **3.1/3.2 PERSISTENCE:** provisioned a Railway **volume** `coliseum-api-volume` at `/data` on coliseum-api (CLI
    `railway volume add` panics unless the dir is linked to the target service first — relinked then it worked). **G-4
    VERIFIED:** rice-dwebble survived a redeploy (still ranked) — data persists. (Note: adding a volume copies existing
    mount-path data in → caused the stale-LB issue above; the migration handles it.)
  - **3.3 field-trust promotion:** live (Sprint 2). **3.5 concurrency:** single worker thread + `_STATE_LOCK` + atomic `_write`.
  - **3.4 sandbox hardening:** done via the FAGAN fixes (rlimit/scrubbed-env/killpg/caps/privilege-drop). **3.6 ADVERSARIAL
    VALIDATION (Docker):** adv-hang → per-decision-timeout forfeit in 8s (no permanent hang — F3/DoS fix CONFIRMED);
    adv-forkbomb → RLIMIT_NPROC capped it, match continued; service `/health` → 200 after both (host survived).
- **DEFERRED (honest, before any PUBLIC/at-volume traffic):** seccomp net-block (network NOT blocked yet — needs the
  Railway-seccomp verification spike; env is scrubbed so no secrets to exfil, but agents can still reach the net);
  F11 (no auth/rate-limit/tar-cleanup; sid-collision); F13 (field-trust 'real owner' = unverified free-text, spoofable).
  → **internal-team OK; don't broadly share the API URL until auth lands.**
- **NEXT: Sprint 4** = E2E + recruit ≥3 real teammate owners to flip field-trust off SYNTHETIC → mostly a HUMAN/operator
  task (real teammates submit). Optional: seccomp spike, F11/F13 auth (gate before public). Sprints 1-3 of 4 live + verified.

**RESEARCH-COUNCIL — the meta-play: a STORM council of our constructs, PROVEN run (2026-06-21).**
- Authored `compositions/experimentation/research-council.yaml` — STORM method (multi-perspective → contradiction map →
  synthesis → peer review) with OUR CONSTRUCTS as opposing seats: **gygax** (practitioner) · **worldline** (historian) ·
  **fagan** (skeptic) · **the-weaver** (synthesis). Modeled on audit-claim's grounding spine. Subject = 5 cabt settled
  beliefs grounded in `grimoires/loa/research/cabt-settled-beliefs.md`. RE-RUNNABLE each cycle = the methodology deliverable.
- Ran via `/compose` Form C runtime (run_id `rescouncil-20260621`, 4 opus agents, ~$6.4). **TERMINAL GATE = valid_run**
  (envelope_digest sha256:b7aed68c…, 4 handoff envelopes + Legba custody chain). First gate read `compiled_run` because I
  skipped step-4 handoff-wrap; wrapped the 4 seeds → valid_run. Real run, not role-play.
- **PAPER: `grimoires/loa/research/2026-06-21-cabt-research-paper.md`.** The council BROKE our "settled" beliefs (it did its
  job): fagan CHANGES_REQUIRED/blocker; reliability B3=70 B4=65 B1=60 B2=55 **B5=35 (BLOCKER)**; paper grade **C+** (research
  B+). Killer findings:
  - **F1 (90): ROOT DEFECT = instrument-flattening.** The beliefs doc STRIPS the `resolution_instrument` tag, so
    ladder-measured facts render at the same confidence as inferred/proxy/zero-evidence claims. One cure: re-attach the tag.
  - **F3: B4 calibration is OVER-CONFIDENCE, not edge** — mean forward Brier 0.262 vs a constant p=0.20 forecaster's 0.16 →
    **Brier skill score −0.64, NET NEGATIVE.** Best-calibrated only when forecasting our OWN failure (the humble p=0.40 bets).
  - **F8 (BLOCKER): B5 teammate-agent rung has ZERO resolved evidence** + is resolved by an instrument with a documented
    false-positive (GAMES-022 floor-vs-floor) → must be CANDIDATE not SETTLED (the exact false-positive shape FAGAN catches).
  - **F5: doc↔ledger breach** — doc says 791.1, ledger says 807.5 for the same sub (the held-margin only reconciles vs 807.5).
  - **Frontier Q:** is v4's 719 a property of the AGENT or of this week's NON-STATIONARY meta? (no belief carries a re-measure trigger.)
  - **Next bet (council-endorsed, cheapest-highest-value):** the deck⊗pilot FACTORIAL cell (vary BOTH axes — B1's interaction
    is currently UNMEASURED) + v4+exactly-one-GOOD-term — BEFORE any coliseum spend. The beliefs ENDORSED the expensive
    coliseum (B5) which the council ranked lowest/least-grounded — the forward-pointing was anti-correlated with the evidence.

**RESEARCH-COUNCIL follow-through — all 3 council recommendations executed (2026-06-21).**
- **(1) F1 applied** → `grimoires/loa/research/cabt-settled-beliefs.md` rewritten: every claim now tagged by
  `resolution_instrument` (LADDER-MEASURED / STRUCTURAL / PROXY / ZERO-EVIDENCE), each belief split into measured
  KERNEL vs inferred SHELL; **B5 demoted to CANDIDATE** (the zero-evidence teammate rung — the council's blocker).
- **(2) The deck⊗pilot FACTORIAL ran** (the council's endorsed next bet; `grimoires/loa/research/2026-06-21-deck-pilot-factorial.md`).
  Pre-registered p=0.40 for a clear interaction, hedged "insufficient most likely" (F3 humility). Coliseum 2×2 (v4/v6 ×
  Dwebble/Abomasnow + greedy), 120 matches: **DECK KERNEL CONFIRMED** — Dwebble cells Elo 1343/1280 vs Abomasnow 869/788,
  **~470 Elo swing** (large effect, transfers). **INTERACTION = INSUFFICIENT** (measures disagree: vs-greedy saturates at
  1.0 on Dwebble; h2h v4-beats-v6 0.67 Dwebble vs 0.50 Abomasnow; Elo gap 63 vs 81 — within noise). Correct humble call:
  the interaction is a near-peer effect the LOCAL band-pass can't settle (B2/§5b) → it's a LADDER-only question. B1 kernel
  holds, B1 shell stays ladder-only. (Bonus: v6-on-Dwebble [never-run cell] = 1280/83% — the strong deck nearly carries the weak pilot.)
- **(3) v2 seats added** → `research-council` **v1.1.0**: the full STORM 6-seat council (added **vitalik** academic/verifier
  stage 2 + **satoshi** economist/cost stage 4 — the v1.0.0 paper's flagged missing perspective). Compiles + validates
  (exit 3, 6 agent_types resolve, ~$9.6/run). Re-runnable next cycle. NOT re-run now (the operator can fire it next cycle).

**COLISEUM matured + the F13 spoof fixed (2026-06-21).** The realness ladder got REAL.
- **Real field exists now:** 2 verified owners — **soju** (operator) + **gumi** (teammate, shipped 13 diverse agents
  v14-v18: sylveon/crustle/firetech/stallmax/mudsdale/archaludon; top gumi-v18-crustle=1308, BEATS our champion 1246).
- **Soju Dash submitted** (operator's flagship v4+Dwebble, owner soju, Elo 1274). Operator: "all my submissions under soju-*".
- **F13 FIXED (it was real — I triggered it):** my old test entry "rice" (owner rice) had spoofed the meter to TRUSTWORTHY
  (3 free-text owners). Operator flagged rice is fake. Fix: `KNOWN_OWNERS` allowlist (soju,gumi) — only verified owners
  count as real; + a token-gated `DELETE /entrants/{id}` (F11 cleanup). Purged rice → meter now honest: **BOOTSTRAP, 2
  verified (soju, gumi).** Admin token in /tmp/coliseum-admin-token.txt (not committed). 
- **B5 BREAKTHROUGH (first real evidence):** the coliseum Elo ORDER now PREDICTS the ladder order for our agents —
  champion(1246)>v5(954)>v6(913) coliseum == 787>569>497 ladder (SAME ORDER). The council demoted B5 to CANDIDATE on
  "zero resolved evidence"; this is the first consilience that the coliseum middle-rung tracks the ladder (for large gaps).
  → B5 moving CANDIDATE → partial-support. The "farm-our-data > synthetic" intuition is now SUPPORTED: gumi's real field
  (which predicts the ladder) is a pre-screen for big swings BEFORE spending ladder slots.
- **PuruPuru design system cloned** (~/Documents/GitHub/purupuru-surface) — `--puru-*` token system (bleed-mix washes,
  old-horai theme, shadcn-composed light/dark). Candidate design language for a cabt-viewer cohesion re-skin (proposed, not done).
- **Today (2026-06-21): all 5 ladder submissions UNUSED** (latest 06-20 @ 787.2). Operator wants BIG SWINGS — pre-screen via the coliseum.
- **SAATY swing-rubric fired** (construct-saaty, AHP, CR=0.0008) → `grimoires/loa/research/2026-06-21-saaty-swing-rubric.md`.
  Dual-score fusion (coliseum + ladder) WITHOUT a hidden average. Weights: C1 ladder-truth 52.4% · C4 info-gain 27.1% ·
  C2 coliseum-vs-gumi 13.5% · C3 deck-fit 7.0%. **Aggregation = HYBRID** (non-compensatory floor: proxy-only can NEVER
  spend a slot — over-confidence correction made STRUCTURAL; then compensatory rank). Forks: coliseum→ladder RANK-ONLY;
  keep C1–C4 (gumi-crustle = C2 sub-screen, don't double-count); split C1→C1a(real,gold)/C1b(map); normalize ideal/reference.
  saaty installed as a PACK (.claude/constructs/packs/saaty) but no Agent adapter generated — fired via general-purpose embodying the real persona+skills.

**FARM LOOP ran → v8-Dwebble SUBMITTED (sub 53930398 PENDING, 2026-06-21).** The big swing today.
- Added coliseum admin endpoints: token-gated `DELETE /entrants/{id}` (F11 cleanup) + `GET /entrants/{id}/bundle`
  (farm-the-field: pull gumi's decks). Admin token in /tmp/coliseum-admin-token.txt.
- **DISTRUST-THEN-VERIFY paid off AGAIN** (the floor-vs-floor lesson, 3rd time): the farm run (N=6) said v6-on-Dwebble
  =1277 (top, beat greedy 1.00). I almost submitted it — but the SMOKE test of the actual bundle lost to greedy 1-3,
  and a diagnostic re-run flipped v6 to 876 (LAST, lost to greedy). Cause: **coliseum.py has NO RNG seed + PTCG is
  stochastic → ~100-400 Elo noise at N=6-8.** Killed the v6 swing (saved a slot on noise).
- **ROBUST N=40 (~800-match) re-measure:** gumi-crustle-full 1144 ≈ **v8-Dwebble 1136** > v6 1111 ≈ v4 1104 ≫ greedy 505.
  Findings: (a) **deck farm BUSTED** — v8-on-our-Dwebble (1136) ≈ gumi's full crustle (1144), so our deck ≈ gumi's;
  **gumi's edge is the v8 PILOT, not the deck.** (b) v6≈v4 (the 1277 was noise). (c) v8 (gumi's threat-aware+expert-
  sequencing pilot) > v4 by ~32 Elo (near noise but mechanistically a better pilot + ladder-proven by gumi).
- **SUBMITTED v8-Dwebble** = gumi's v8 pilot (build_v8dw, their main.py reads deck.csv) + OUR Dwebble deck. Teammate-farm.
  Pre-registered **p=0.52** (hash-chained: cabt-forecasts.jsonl, decision_id `farm-gumi-v8-pilot-on-dwebble`, anchor bumped
  to 498832760b83). Resolve when the ladder scores it.
- **DURABLE FIX NEEDED: seed coliseum.py's RNG + default high N** — low-N coliseum is too noisy to pre-screen near-peer
  pilots (large effects like the deck axis ~470 Elo survive; pilot ~30 Elo don't). The B5 "coliseum predicts ladder"
  used the SERVICE's many-match Elos (more stable); local N=6 runs are NOT trustworthy. v8-pilot is also a farm target for OUR own pilot.

**2026-06-22 — SEED-FIX shipped + OUR OWN v7 pilot built + v8-Dwebble ladder HELD.**
- **Seed-fix (coliseum reliability):** the cg engine (libcg.so) auto-seeds natively + exposes NO Seed() symbol → matches
  are NOT reproducible from Python. So the fix is HONEST-INSTRUMENT, not true seeding: default `--n` 4→20, a Wilson 95%
  CI on every win%, and a 🎯 RELIABILITY section flagging adjacent ranks as `✓ robust` vs `⚠ WITHIN-NOISE` (h2h CI
  straddles 0.50) — the exact guard that would have caught the v6-1277 fluke. `--seed` controls harness randomness only.
  (coliseum.py: wilson_ci + reliability block + win_ci/reliability in JSON.) Validated.
- **OUR OWN v7 pilot (src/cabt/heuristic_v7.py):** the v8-class ideas done as OUR code, NOT a copy of gumi's — true-damage
  KO (base ×2 on real Weakness-type match, v4's #1 gap), threat-aware retreat (energy-aware opp max-dmg; the fix augury's
  card_aware REGRESSION lacked), expert sequencing (KO>draw>search>evolve>develop>ability>ATTACH-last>attack), recoil
  safety, safe-promotion/boss-target. Registered: CABT_POLICY=v7 (agent.py) + coliseum _BUILTIN "v7". Added additive
  accessors to cards.py (weakness_type/energy_type/prize_value/attack_ids/attack_cost/attack_text). Behaviorally FIRES
  (33% of MAIN decisions differ from v4, card DB loads 1267, 0 errors — not a no-op floor).
- **v7 validation (seeded N=40, all on Dwebble):** v7 #1 (1127) but the **TOP-4 are ALL WITHIN-NOISE** (v7 1127 ≈ v4 1110
  ≈ gumi-v8 1096 ≈ v6 1079; all CIs overlap, all adjacent h2h straddle 0.50); only `v6≻greedy` is robust. So **the pilot is
  a FLAT lever on the strong Dwebble deck** — our v7 successfully MATCHES gumi's v8 (we have our own v8-class pilot), but
  neither clearly beats v4 here. The trustworthy instrument SAYS so now (the fix earns its keep).
- **v8-Dwebble ladder HELD (sub 53930398 = 808.9 > v4 baseline 787, +21.9 small positive).** Forecast p=0.52 → **Brier
  0.2304**, resolved on cabt-calibration-logged.jsonl. Well-calibrated slightly-favored call. The §5b BAND-PASS in action:
  the pilot is a SMALL-but-real LADDER lever the N=40 coliseum reads as within-noise (near-peer pilot effects are
  ladder-only-resolvable). deck = big lever, pilot = small lever — reconfirmed. v7 is the candidate to reproduce this small
  edge with OUR code on the next slot (info-gain) — but HOLD until we see if the pilot edge is worth a scarce slot.

**META OBSERVATORY built (.cabt-spike/coliseum/meta_observatory.py) — the metacognition instrument.**
- **The reframe (questioned the "loop deck experiments" ask):** the ladder meta is HIDDEN, but every agent we've
  submitted is a PERMANENT FREE meta-probe — Kaggle re-scores it continuously, so a FROZEN agent's score DRIFT *is*
  the meta shifting under us. Evidence: v4-Dwebble eroded **807→754.9 in 2 days** (code frozen) = meta hardened ~52pt;
  v8-Dwebble (808.9) clawed back to where v4 was. So we SENSE the meta for free (drift) + spend the 5 slots as an
  explore/exploit BANDIT, never to sense.
- **The instrument (3 lenses, stdlib, runs on Mac):** (1) DRIFT — logs a snapshot per run to
  `grimoires/loa/lab/cabt-meta-drift.jsonl`, flags probes moving beyond ±30pt as meta-shifts; (2) COLISEUM-FARM —
  aggregates ALL coliseum result JSONs into a pilot×pilot matchup matrix with Wilson-CI reliability; (3) PROPOSE —
  explore/exploit slot framing. Re-runnable daily (free). SENSES + PROPOSES; never submits (slots stay SAATY-gated).
- **Farm finding (8 runs, 1720 games — more power than any single run):** **v7 ROBUSTLY beats v6** (0.61, 49/80,
  CI≥0.50 ✓) — v6 is the shipped agent.py default + scored only 497.8 on the ladder. All heuristics crush greedy
  robustly (v8 .97, v7 .96, v4 .92, v6 .80). Everything else among v4/v7/v8 is within-noise (deck-saturated — deck
  is the lever). Best planted probe = v8-Dwebble 808.9.
- **NEXT BUILD (the PROPOSE lens's stub):** a deck-variant generator → CI-gated coliseum pre-screen → SAATY rubric →
  fills the day's explore/exploit proposal with concrete candidates. Optionally wire a daily /schedule cron (free sense+propose).

**FULL ADAPTATION LOOP built + ran end-to-end (2026-06-22).** SENSE → GENERATE → FORGE → PRE-SCREEN → PROPOSE.
- **Pieces (all in .cabt-spike/coliseum/):** `meta_observatory.py` (sense/drift/farm), `deck_forge.py` (apply swap-specs
  → legal 60-card variants, validates), `adapt_loop.py` (orchestrator: `--sense` daily / `--adapt SPEC` full pass),
  `daily_sense.sh` + `com.cabt.dailysense.plist` (launchd daily heartbeat, ready to activate). Generator = the **gygax
  construct** (deck-building domain) → designed 4 single-axis variants (`gygax-variants.json`), each probing a DIFFERENT
  meta-hypothesis so the PATTERN is diagnostic: exbelt({ex}-patch via Maximum Belt), boss(gust the wall), pivotheal
  (anti-attrition), lean(variance null-control).
- **LOOP EARNED ITS KEEP IMMEDIATELY (distrust-then-verify):** the pre-screen flagged 2 of 4 variants playing 0 games.
  Diagnosed: **exbelt + pivotheal decks are ENGINE-REJECTED** (battle_start→None, errorType=4). **KEY GOTCHA:
  EN_Card_Data.csv is a SUPERSET of the engine's constructible set** — Maximum Belt[1158]/Switch[1123]/Poke Vital A[1096]
  exist in the data but are deck-ILLEGAL in this format. gygax couldn't know (engine is Linux-only). deck_forge's
  legality check (60/≤4/core) is necessary-but-NOT-sufficient; the ENGINE is the final authority, caught at pre-screen.
- **VERDICT (the 2 legal variants, N=30 CI-gated, seeded):** crustle-lean 1083 ≈ v4-PB 1108 ≈ gumi-v8 1114 (all
  WITHIN-NOISE); crustle-boss 1050 (slightly worse). **NO variant robustly beats the PB → nothing to submit today**
  (honest hold). Diagnostic INCOMPLETE: the strongest hypothesis ({ex}-patch) couldn't be tested (Maximum Belt illegal);
  lean≈PB hints variance is NOT the drag (erosion is external). Best agent remains v8-Dwebble (808.9, banked).
- **NEXT FIX:** extract the ENGINE-LEGAL card set (a card-constructibility probe in Docker) → constrain gygax's pool →
  re-design the {ex}-counter + attrition variants with LEGAL cards → re-run --adapt. THEN the loop proposes real swings.
- **CRON:** `daily_sense.sh` (free drift+farm+shift-alert) → activate via launchd (`launchctl load com.cabt.dailysense.plist`).
  Local (cloud cron can't reach the local repo + kaggle CLI + Docker). Submissions stay SAATY-gated.

**Engine-legal-card PROBE built + cap-aware (`card_legal.py` → `legal-cards.json`).** Two layers of the EN_Card_Data.csv⊋engine
gotcha, both now caught: (1) some cards are flat ILLEGAL (cap 0 — Maximum Belt[1158], Poke Vital A[1096]); (2) some are
legal-at-1-but-capped (**Hero's Cape[1159] = cap 1**, ACE-SPEC-style — the ONLY card capped below 4 in the 359-card
trainer/energy pool; 331 legal, 28 illegal). Probe sets the candidate to K copies (4→1 descending) in the legal base,
battle_start = the cap. `legal-cards.json` carries `caps`/`capped_below_4`/`illegal`/`names`.
- **gygax SELF-CORRECTED a load-bearing misread (verbatim re-read + consilience):** Crustle[345] "Prevent all damage done
  to this Pokemon by attacks from your opponent's Pokemon {ex}" → {ex} modifies the ATTACKER, so Crustle **WALLS ex** and
  is vulnerable to **non-ex / status / non-attack** damage (the OPPOSITE of the first read, which I'd propagated). Consilience:
  Dwebble/Crustle is most-played + BEATS the ex-heavy field 0.73-0.81 (can't dominate ex if null-vs-ex). The {ex}-patch was
  DROPPED (solves a won matchup). Confirmed the ability text directly.
- **DO-NO-HARM RULE (the pivotcleanse lesson):** a variant must NOT cut the draw engine (Lillie's/Waitress/Poffin) — pay for
  tech from over-floored Basic{G} or marginal Spiky/Mist energy. pivotcleanse regressed (1026) BECAUSE it cut draw; recur
  (Items only, no draw cut) HELD ≈ PB (1107). The coliseum field lacks the real counters → variants are LADDER info-gain
  bets (C4); the pre-screen only gates do-no-harm.
- **STATE:** crustle-recur (chip-grind) = the clean do-no-harm survivor so far. gygax round 3 running = a cap-aware DIAGNOSTIC
  LADDER SWEEP (4 legal variants, distinct eroding-counter hypotheses; the PATTERN of ladder results is the meta read). The
  "big swing" honest reframe: Crustle is converged + the pilot is flat → no single big deck swing; leverage = spend the 5
  slots as a diagnostic sweep to learn which counter erodes us. NO slot spent yet (operator: fix probe + 1 more gygax round first).

**DIAGNOSTIC LADDER SWEEP SUBMITTED (2026-06-22) — 3 slots, the metacognition play.** gygax round 3 (cap-aware) +
the do-no-harm pre-screen (N=30) yielded 3 legal do-no-harm variants, each probing a DISTINCT non-ex counter-mechanism
(the PATTERN of which clears the contemporaneous v4-base localizes the eroder). All v4 pilot (proven dwbundle + variant
deck.csv; v4 fires the tech on-play), all smoke-passed (start+play, no engine-reject):
- **cage** (sub 53955580, p=0.45) — Battle Cage[1264] blocks bench damage-counters = gygax's top read (the named Alakazam
  counter, 0.80 vs us ~16%). OUT 2x Spiky / IN 2x Battle Cage.
- **charm** (sub 53955581, p=0.40) — Sacred Charm[1177] -30 from ability-attackers (active HP-race). OUT 3x Spiky / IN 3x Charm.
- **cleanse** (sub 53955582, p=0.38) — Switch[1123]+Lumiose Galette[1153] clear status. OUT 4x Basic{G} / IN 2+2 (paid from
  energy = the do-no-harm fix of the regressed pivotcleanse).
All 3 pre-registered (hash-chained, cabt-forecasts head 84f51b7b). recur DROPPED (flipped to robust-worse at N=30 — the
renewable-wall Items are dead in the no-grind mirror). 2 slots reserved; gumi-v8 (808.9) stays the banked best.
RESOLUTION: when they score, compare each to the CONTEMPORANEOUS v4-base (53868523) via the drift sensor (clean, pilot-held);
the pattern = the meta read. gygax's caveat: if NONE clears 754, the eroder is the unpatchable active-ability-damage hole or
an unmodeled mechanism (itself informative). Brier-score each on resolution.

**STORM COUNCIL ran (8 agents) to package our loop for El Capitan [OHM] — who's building a parallel engine (gym/TurnTrace/
FunSearch/Coach, ready ~cycle-014). Paper → `grimoires/loa/research/2026-06-22-two-evidence-loops.md` (peer-review-passed).**
The council EARNED ITS KEEP by overturning my own framing + catching 3 over-claims before they reached a teammate:
- **CORRECTION 1 (the big one): cross-engine AGREEMENT is NOT a new realness rung.** Two field-blind, self-play-rooted
  instruments grading the same closed engine share the SAME blind spot → agreement = shared bias read twice, not
  consilience. The informative event is **DISAGREEMENT adjudicated by the ladder.** (Small exception: a RE-IMPLEMENTED
  engine's agreement rules out per-engine artifacts = minor independent info.) I'd told soju "agreement = consilience" — backwards.
- **CORRECTION 2 (fagan): the "~470 Elo deck axis" was a distortion** — 807.5−719.1 = +88 (the only constructive deck gain,
  N=1); 470 was the deck DOWNSIDE (−400/−494). And the pilot is NOT flat on the LADDER (v8 +21.9 UP held; v5/v6 −156/−236).
  Honest: upside small on BOTH axes (+88 deck / +22 pilot, both N=1, neither coliseum-resolvable); we're on the converged deck
  so both are near-peer now. Don't call either axis "the lever."
- **CORRECTION 3 (fagan): frozen-drift senses the meta-shift of ALREADY-submitted agents — it CANNOT evaluate a novel
  candidate** (a new FunSearch output still needs a slot). And the Brier "we're overconfident" was weaponized humility
  (~0.257 vs naive 0.24 = near-tie; the loop self-corrected). We also UNDER-rated FunSearch (population extremum-selection
  out-samples our 6 hand-picked bets) and the SAATY-floor's winner's-curse protection is undemonstrated (the 1277→876 fluke
  was caught by higher-N, not the floor).
- **2 missing seats added:** game-theorist (the field is NON-STATIONARY + RPS-triangle → imitating the converged meta is a
  Red Queen treadmill → counter-meta/exploitability search, not imitation); objective-framing (does "Simulation" score the
  best AGENT or the best METHODOLOGY? if the latter, the frontier question IS the deliverable).
- **VERIFIED:** libcg.so exports no Seed symbol (only BattleStart/Select/GameInitialize/SearchBegin/BattleFinish) + re-runs
  non-deterministic → the no-Seed fact (root of the band-pass + non-causal-attribution) holds. The 2-engine calibration
  protocol: gate first (same-engine? seedable? eval-baseline?) → spend slots only on ladder-resolvable DISAGREEMENT.
  FRONTIER: can instrument-independence (how much real-distribution info a gym carries) be measured CHEAPLY before a slot is spent?

**DIAGNOSTIC SWEEP RESOLVED (2026-06-22) — NEW PB 986.1 + the eroding counter localized as STATUS.**
- **cleanse (status-clear: Switch+Lumiose Galette) = 986.1** → HELD, +231 over v4-base 754.9, +177 over the prior best
  (v8-Dwebble 808.9). NEW BEST BY FAR. Brier 0.3844 (p=0.38 — UNDER-confident on the winner, Dwebble pattern again).
- charm (ability-reduction) = 772.2 → INSUFFICIENT (+17, within ladder noise, unscored).
- cage (bench-spread/Alakazam) = 600.0 → FALSIFIED, −155. Brier 0.2025 (p=0.45 — OVER-confident on the loser).
- **THE LESSON, sharp: gygax's HIGHEST-confidence read (cage) lost hardest; his LOWEST (cleanse) won biggest.** The
  poisoned-well runs the wrong way even for the expert (v6-term + floor-vs-floor, now cage, all the same shape). The
  SWEEP (orchestrated diversity) + the LADDER (ground truth) found what expertise/confidence alone could not. The
  eroding counter is STATUS (the ex-wall is null to poison/burn placed between turns, not "by an attack").
- **CONSTRAINT: only 2 submissions live at a time.** Keep **cleanse (986.1) + v8-dwebble (808.9)** live (our 2 best);
  cage (600, a known regression) + charm (772, marginal) off. NEXT adaptation: DOUBLE DOWN on status (more status-clear
  / condition-immunity tech, e.g. Festival Grounds) now that status is the confirmed counter — and re-run the sweep
  pattern as the meta keeps shifting (it's non-stationary).

**CYCLE-2 SWEEP — NEXT-COUNTER explore (2026-06-22, the long-con play; awaiting operator submit).**
- **SENSE first:** cleanse's latest ladder poll = **955.9 (−30 from its 986.1 PB)** — right at the ±30 noise edge (sub
  53955582 = "v4/crustle" in observatory labeling). No confirmed meta-shift; status may be near-ceiling/eroding → do NOT
  pour slots into status-max. Frozen probes (v8 808.9, v4 754.9) flat over the 0.1-day window.
- **gygax v4 design** (`gygax-variants-v4.json`): 3 distinct, legal, do-no-harm variants off sub_dwebble_v4 (all −3
  Basic{G}[1] / +3 tech → energy 28≥27; draw engine Lillie's/Waitress/Poffin + heal engine Cook[1212]/Jumbo[1147] +
  Hero's Cape ALL intact). Card text re-verified in EN_Card_Data.csv. Festival Grounds[1245] text CONFIRMED = passive
  symmetric condition-immunity for energized Pokémon (a Stadium → bumpable, unlike cleanse's Items).
  - **crustle-fg** (+3 Festival Grounds): STATUS-MAX exploit. p=0.55.
  - **crustle-helmet** (+3 Lucky Helmet[1156] draw-2-when-damaged): NEXT-COUNTER, resource-EXHAUSTION hypothesis. p=0.42.
  - **crustle-pivot** (+3 Air Balloon[1174] retreat −2): NEXT-COUNTER, single-wall-BURST hypothesis. p=0.33.
- **Pre-screen N=30 (Docker, do-no-harm gate; v7 pilot, 900 matches 0 non-terminating):** ALL 3 pass do-no-harm (none
  collapses). Ranks helmet **1192 (0.74, robustly #1 over fg)** > fg 1089 > v4-PB-base 1071 > gumi-v8 1066 > pivot 1012
  (0.48, within-noise at/below base) > greedy 569. NOTE: the coliseum is BAND-PASS + internal-field (real=1) → this is
  the down-weighted C2 proxy, NOT a ladder prediction. gygax's confident pick (fg) did NOT lead locally — the cage-shape
  warning again (his top pick lost last cycle too).
- **SAATY gate → operator chose helmet + pivot** (drop fg). 2-slot ceiling + **"playing for the long con"**: fg refines a
  possibly-eroding KNOWN status edge (cleanse already banks status live); helmet/pivot are the EXPLORE — a
  mutually-exclusive pair (only one should move) that LOCALIZES the next counter, the non-stationary-meta priority. A
  double-flat is itself high-info (residual loss un-teachable from our pool → lever moves off the deck). CONFOUND flagged:
  built off v4-base (not cleanse), so the bar is "beat base DESPITE not fixing status" → correctly low/C4-info-gain p's.
- **PRE-REGISTERED (anchor bumped 84f51b7b → 8f74cfad; logged BEFORE outcome):** `deck-helmet-vs-exhaustion` p=0.42,
  `deck-pivot-vs-burst` p=0.30 (pivot dinged below gygax's 0.33 by its weakest pre-screen). 13 forecasts total, chain intact.
- **Bundles built + isolated-validated** (`.cabt-spike/build_{helmet,pivot}/` + `submission-{helmet,pivot}.tar.gz`, 23
  entries each, v4 pilot, decks verified): both ✅ LEGAL, 0 crashes. (Smoke win% 0.00/0.10 is a wall-mirror-vs-floor
  artifact — the proven cleanse bundle scores 0.10 in the same smoke; legality+no-crash is the real gate.)
- **AWAITING OPERATOR SUBMIT** (Kaggle creds absent in-session): submit `submission-helmet.tar.gz` +
  `submission-pivot.tar.gz` to `pokemon-tcg-ai-battle`. cleanse (986.1) stays banked champion. On ladder score:
  resolve each via `resolveRegisteredDecision` → Brier → read the PATTERN (which loss mode moved) → localize next counter.

---

## TWO BIG SWINGS — belief update + pre-registration (2026-06-25, GAMES-024)

**Frame.** Operator: "two big swings after comprehensively updating beliefs + pre-registering." Embodied
**gygax** (game-systems) + the calibration discipline. Used `/recall` (federated) + `/compose` (the v8 build ran
through `code-implement-and-review`, FAGAN-gated). The naive first draft (cleanse+v7 pilot-alone vs raw-Alakazam) was
**dismantled by gygax** — the dismantling IS the belief update.

**THE EV MAP (gygax + field/echelon, 754 real matches).** We are on the converged top deck, where council §5.2 already
said BOTH the deck-tweak and pilot axes are SMALL levers. The decisive realization: **the EV-dominant matchup is the
65% Crustle MIRROR (50-50 over 494 games), NOT the 9% Alakazam hole.** Math: a +5pt mirror lever = **+3.3% overall WR**
(touches only the mirror, keeps the 91% we already win) vs a full Alakazam solve's +2.7% that *risks* the other 91%.
The 9%-hole instinct (cage, −155) was a trap; the mirror is where the points are.

**WHY cleanse+v7-alone is FLAT (gygax, file:line-grounded).** Every one of v7's signature features is DEAD in the
cleanse shell: multi-prize retreat (Crustle is single-prize), Weakness×2 KO (both {G}, never fires in the mirror),
**Boss-target-best-KO (cleanse runs ZERO Boss's Orders → no card to act on)**, recoil-safety (no recoil). Worse, v7's
*hand-dumping* sequencing fights the wall-mirror's stall/deck-out rhythm → downside tail "mildly counterproductive."

**WHY raw Alakazam is a TRAP (gygax p~0.15).** Same family as mono(205)/rebuild(225). **THE KILLER: Powerful Hand =
20×hand-size**, so the optimal line is HOARD-then-swing — but v4/v7 do the OPPOSITE (play hand out, attack last).
Bot-hostile profile **20P/7E/33T** (vs Dwebble's bot-friendly 31E/8P/21T) + Stage-2 line + Rare Candy timing.

**THE TWO BIG SWINGS (pre-registered, LOGGED before any eval; anchor 8f74cfad → 5faa29f3, 15 forecasts, chain intact):**
- **SWING 1 — `cleanse-boss-orders-v7-mirror`, p=0.40, effect small.** cleanse deck −2 Basic{G} +2 Boss's Orders[1182],
  piloted by v7. The EV-dominant mirror lever (gust a benched Dwebble 70HP so Crustle 120 KOs it BEFORE it evolves =
  setup-denial + tempo) AND the ONE config where Boss's Orders ACTIVATES v7's dead Boss-target feature. Co-designed
  deck+pilot. POISONED-WELL discount: this is gygax's CONFIDENT #1 read, and his confident reads have been
  anti-correlated (cage/energy-term falsified; his weakest read, cleanse, won biggest) → middling p by design.
- **SWING 2 — `deck-alakazam-v8-powerful-hand`, p=0.20, effect large.** The converged Alakazam deck (the field's apex,
  60.3% WR, beats our Crustle 80%) + a NEW hand-size-aware **v8 "Powerful Hand" pilot** (hoard then swing on a full
  hand; Stage-2 priority). The counter-meta structural break the 2026-06-22 council named ("imitating the converged
  meta is a Red Queen treadmill; the move is counter-meta search"). v8 fixes THE KILLER, not the Stage-2/Cage/energy
  secondaries → a huge-upside, max-info long shot; if it lands it BREAKS the Crustle ceiling, if it fails it fails large.
  **KILL-GATE (don't submit if pre-screen shows):** mean hand-size when Alakazam attacks ≤4, OR Stage-2-online <60% /
  median evolve-turn >5, OR coliseum WR vs the Crustle wall <45% (field Alakazam wins 80% — if ours can't clear 50% the
  pilot threw the edge).
- gygax's #2 (cleanse + 2 Enhanced Hammer[strip the mirror's 12 special energies] + v4) = the on-deck FALLBACK if
  Swing 2 is kill-gated, and the natural next mirror probe.

**Build status:** Swing 1 `submission-boss-v7.tar.gz`, Swing 2 `submission-alakazam-v8.tar.gz` (v8 built via `/compose`
code-implement-and-review, FAGAN-gated + my own review + py_compile), mirror-alt `submission-hammer-v4.tar.gz` — all
BUILT, does-it-run ✅ (Docker smoke: LEGAL, 0 crashes each). 16 forecasts, chain head 66f3d835.

**PRE-SCREEN VERDICT (coliseum round-robin, Docker, N=8, 448 matches 0 non-terminating; SYNTHETIC/band-pass — KILLS
collapses, cannot bless edges). The diversity-pair PAID OFF — the mirror swing FLIPS from Boss to Hammer:**
- **hammer-v4 (gygax #2) = rank #2, 0.59** — beats the Crustle wall (spar-dwebble) 0.56 AND beats the cleanse PB deck
  0.56. The clean mirror lever (resource-denial, no pilot dependence).
- **boss-v7 (the v7 mirror bet) = rank #7 (below greedy), 0.48; LOSES to the wall 0.19.** gygax's "v7 hand-dumping is
  counterproductive in the wall mirror" warning + TWO pre-screens converge → **do-HARM. Pre-screen caught it before a
  ladder slot (its whole job).** `cleanse-boss-orders-v7-mirror` (p=0.40) stays LOGGED + UNRESOLVED (built, not submitted).
- **alakazam-v8 = rank #4, 0.55; BEATS the cleanse PB deck 0.62 h2h** (functional, NOT a mono/rebuild collapse) but vs
  the Crustle wall clone = 0.44 (just under gygax's 45% gate → underpiloted vs its 80%-vs-Crustle ceiling; the Stage-2
  setup secondaries cost it). A genuine p=0.20 long shot — survives the kill-gate (does-it-run + not-a-collapse), the
  ladder resolves whether v8 extracts enough of Alakazam's structural edge.

**→ THE TWO SWINGS TO SUBMIT (operator, Kaggle creds absent in-session):**
1. **MIRROR — `submission-hammer-v4.tar.gz`** (`cleanse-enhanced-hammer-v4-mirror`, p=0.40). [Boss+v7 was the pre-reg
   but pre-screened do-harm; Hammer is the diversity-pair winner.]
2. **STRUCTURAL — `submission-alakazam-v8.tar.gz`** (`deck-alakazam-v8-powerful-hand`, p=0.20). The counter-meta break.
Submit to `pokemon-tcg-ai-battle` (5/day). Resolve each via `resolveRegisteredDecision(id, {instrument:"ladder-measured"},
marginPpm)` → Brier → the PATTERN localizes whether the 986→ lever is mirror-tech (Hammer) or the structural break (v8).
**ENV FLAG:** disk hit 100% (118Mi free) mid-session → Docker Desktop crashed; recovered to 4Gi after relaunch. Docker.raw
is 60GB — operator should reclaim disk (`docker system prune` / trim caches) before the next Docker-heavy pre-screen.

**COMPOSE PAID OFF + a real bug.** v8 authored via `/compose code-implement-and-review` (CONVERGED, 3 iters, FAGAN-
APPROVED). FAGAN caught what my own review MISSED: `cards.py` has NO public `card()` accessor → the first-built v8's
`cards.card(id).name` was DEAD (NAME detection silent no-op). Converged v8 reads `cards._CARDS` read-only → Rare-Candy +
Stage-2 LIVE; rebuilt bundle + re-pre-screen: alakazam-v8 vs the Crustle wall rose **0.44 → 0.56 (clears gygax's 45%
gate)**. (No `valid_run` custody stamp — the Legba gate correctly refused a post-hoc hand-injected envelope; I did NOT
forge it. Convergence is real per the workflow completion record.) **LATENT v7 BUG:** `heuristic_v7._hand_card_name`
(line 144) routes through the same dead `cards.card` → v7's draw/search sequencing is dead (partly explains boss-v7's
do-harm pre-screen). FOLLOW-UP: add a public `card_name(id)` to cards.py; repoint v7 + v8.
