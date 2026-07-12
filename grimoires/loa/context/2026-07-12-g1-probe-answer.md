# loa-finn probe

## purpose
- finn is "a research engine — and the runtime that rides it" `README.md:L24`; it answers one question — **what's real?** — by pre-registering bars before data exists and settling with deterministic instruments, with the agentic economy as application #1, not the definition `README.md:L26`.
- Discipline: register → probe → settle; verdicts are `HELD / FALSIFIED / INSUFFICIENT`, "never from an LLM," and a falsification is progress `README.md:L42`.
- Operating shape: "a shop, not a monolith" — finn grinds small falsifiable gadgets and keeps/sells/throws each, all shelved with a binding check on the gadget ledger `README.md:L30`.
- The runtime body underneath (multi-model routing, WAL, cron, sandbox, checksummed cost meter) exists to make experiments cheap and durable `README.md:L28`.
- Status: "Active as a lab"; the runtime half is built but not deployed — every recorded Deploy-to-ECS run failed, so runtime claims are code-reality, not production-reality `README.md:L144`.

## gadgets
- The ledger is the machine source of truth; status vocabulary is CLOSED: `CANDIDATE | KEEP | SELL | THROW` `grimoires/loa/lab/GADGETS.md:L3-L8`, and the rigor floor is "no row without a runnable check" `grimoires/loa/lab/GADGETS.md:L20-L21`.
- 15 rows: 13 KEEP + 2 CANDIDATE, every check `runner: vitest`, `exit: zero-is-pass` `grimoires/loa/lab/GADGETS.md:L26-L136`.
- **gadget-001-realness-verdict** — SETTLE verdict math as a pure module; KEEP, vitest on its lab dir, graduation pending `ledger:gadget-001-realness-verdict`.
- **metabolism-\*** (8: cartographer, hand, loop, loyal-traitor, ledger, oracle, population-ledger, verify) — the PSRO metabolism; all KEEP, checked by vitest on `src/lab/metabolism`, all src-imported, e.g. the regret-matching meta-solver `ledger:metabolism-cartographer` and the fail-closed re-checker `ledger:metabolism-verify`.
- **shop-\*** (4: cite-check, ledger-check, probe, corpus-scrub) — the shop's own gates; all KEEP, vitest on `src/lab/shop`, src-imported with `loc_ceiling`s, e.g. the citation validator `ledger:shop-cite-check`.
- **candidate-002-survival-forecaster** and **candidate-003-realness-score** — CANDIDATE, brief-only, `contract: pending` (visible debt) `ledger:candidate-002-survival-forecaster`.

## proven
- **EXP-001** (cost-of-play): H1/H2 FALSIFIED — inference is 93.7% of per-call cost, not infra; H3 HELD `README.md:L77`.
- **EXP-002** (agent-commerce forensics): registration theater — 39,999 registered → ~0 transacting; $320.9M of "commerce" was prize distribution `README.md:L78`.
- **EXP-003** (verify-the-void): GO-vertical / NO-GO-horizontal — demand is real but vertical + in-house `README.md:L79`; the commerce ambition thereby self-settled `grimoires/loa/lore/lineage.md:L63-L64`.
- **EXP-004** (graduation gate): pre-registered next, not yet settled — the sybil layer + precision/recall harness must exist before any forensic claim `README.md:L80`.
- **SETTLE-001** (x402 wash): RESOLVES TRUE, understated — ~99.3% of x402x volume is `payer == payTo` self-dealing, settled by Dune query 7717781 `grimoires/loa/lab/SETTLES.md:L30-L43`.
- **SETTLE-002** (theater persists): HELD — genuine USD and payers both decline, self-dealing 95.9%; Brier 0.1225, under-confident `grimoires/loa/lab/SETTLES.md:L125-L132`.
- **SETTLE-003** (Kintara $KINS, the positive control): HELD[real] with margin — 29,009 traders, top-1 5.78%, growing `grimoires/loa/lab/SETTLES.md:L232-L234`; the filter has now returned both verdicts on deterministic evidence, so "it only ever says fake" is itself falsified — the instrument discriminates `grimoires/loa/lab/SETTLES.md:L245-L248` (desk Brier 0.49, wrong-side `grimoires/loa/lab/SETTLES.md:L252`).
- Score edges remain unbuilt (`NotImplementedError`, fixtures-only) — no forensic claim is earned until EXP-004's kill gates fire `README.md:L137`.

## origin
- Three lives: Dec 2025 "Agentic Base" prehistory `commit:3b206d7b`; Feb–May 2026 minimal runtime → agent-commerce platform (`commit:9c92ae69` → `commit:0eda3ed3`); Jun 2026 → research engine / appraiser `commit:7887268b` `grimoires/loa/lore/lineage.md:L11-L15`.
- Genesis was one day, all the founder's hand (2026-02-06): research doc + PRD + v0.1.0, the minimalist "k3s moment" counter-thesis to loa-beauvoir, born in `commit:421f4a44`.
- Founder intent arced from hardening to the commercial turn (x402, Per-NFT Personality on Mibera) but the Goodhart loop stalled — "it scores but doesn't route, it verifies but doesn't settle" — and his last mainline commit was 2026-04-05 `commit:5b28c428`; no farewell artifact exists `grimoires/loa/lore/lineage.md:L37-L46`.
- Handoff: a second-hand Discord custody grant (2026-05-04, unsigned) plus verified git silence on the takeover PR; the operator's first native wave was cycle-032 `commit:b895f888` `grimoires/loa/lore/lineage.md:L50-L56` (custody claim class: `claimed` `grimoires/loa/identity/claim-inventory.yaml:L34-L36`).
- The June pivot re-read the founder's own naming deeper — the appraiser who tells real from counterfeit — and the shop still rides the body he built (WAL, hounfour, sandbox, gateway) `grimoires/loa/lore/lineage.md:L66-L72`.
