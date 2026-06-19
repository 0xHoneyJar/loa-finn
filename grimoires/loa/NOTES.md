# NOTES.md

## Session Continuity

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
