---
status: active
created: 2026-06-12
author: session (EXP-003 pre-registration, operator-paced)
ratified_at: 2026-06-12 (operator "Go" — bars pinned, run C1 first alone)
hivemind:
  schema_version: "1.0"
  artifact_type: experiment-design
  product_area: "Finn — EXP-003 verify-the-verification-void (claimed→settled)"
  workstream: experimentation
  priority: high
  jtbd: {category: functional, description: "settle the external agent-economy report's load-bearing claims before staking build effort on the verification-void pivot"}
  learning_status: directionally-correct
  source: team-internal
grounding:
  - "external agent-economy report (2026-06-12) — EXTERNAL/attested, use=background_only. Every claim below enters at CLAIMED tier; this experiment settles them."
  - "ACVP vault page — activated background doctrine. The void the report names = ACVP applied; Loa substrate already instantiates components (compose-verify-run valid_run + CostAtom hash-chain)."
  - "EXP-001 (Score SKU = forensic integrity scoring, WTP institutional-provenance) + EXP-002 (on-chain agent economy is registration theater) — settled priors that motivate the pivot."
  - "epistemology-deterministic-layers.md — the measurement register + L0-L4 ladder this pre-registration obeys."
---

# EXP-003 — Verify the Verification Void (pre-registration)

> The realness filter, pointed at the research that would justify the pivot. The external
> report is a bag of CLAIMED-tier beliefs; the program's job is to settle them BEFORE build
> effort lands on an unverified assumption (the EXP-001/002 discipline). Zero Dune — public
> sources, grounded web search (k-hole, gemini-CLI flash route), on-chain explorers.

## Positioning (operator-ratified, SEAM-1 prior)
**Staged: Score vertical → horizontal.** Score's forensic-integrity scoring (EXP-001 SKU, real
WTP) is the first concrete vertical OF a horizontal Loa-ACVP verification layer. We verify the
report to decide whether the horizontal expansion path is real before building toward it.

## Report status (operator-ratified)
**Claimed-tier inputs to verify.** No number below is a fact or a requirement until an instrument
confirms it. Findings tag observed vs claimed; named-party claims state structural facts only
(defamation guard — the EXP-002 discipline).

## Run order (operator-ratified)
Pre-register all four clusters; **run C1 + C2 FIRST** as the pivot GO/NO-GO. C3/C4 defer to the
build phase, only if C1+C2 hold.

## Verify-clusters (the bars)

### C1 — The verification void is real *(GO/NO-GO · load-bearing)*
- **Claim (attested):** ERC-8004's Validation Registry (the re-execution/stake/TEE/zkML layer) is
  unfinished "design space"; EigenVerify is not-GA; nobody sells fraud-provable agent task
  completion at scale. Only verifiable-inference/compute (Phala, EigenCompute) is shipped.
- **Source-of-truth (zero-cost):** ERC-8004 EIP status page + reference contracts (8004scan);
  EigenCloud docs/changelog for EigenVerify GA + named paying customers; a competitor sweep for
  any shipped+paid fraud-proof-of-work product.
- **Settle:** **HELD** if the Validation Registry spec is non-final AND no GA competitor with
  paying customers is found. **FALSIFIED** if a shipped, paid fraud-proof-of-agent-work product
  exists with disclosed customers. **INSUFFICIENT** if the spec is final but no product ships.
- Level: L2 (structural — spec status + product existence are checkable, "nobody at scale" is a bounded-search claim).

### C2 — Real agent commerce exists to verify *(GO/NO-GO · load-bearing)*
- **Claim (attested):** enterprise vertical ARR is real (Sierra ~$200M, Harvey >$200M confirmed /
  ~$300M Sacra-estimate, Decagon ~$35M); x402 real volume ~$28K/day (≈half gamed) under a
  165M-tx / ~$50M-cumulative headline.
- **Source-of-truth:** ARR corroborated by ≥2 independent sources, with the Sacra-estimate vs
  CEO-confirmed divergence stated explicitly (the report's own caveat); x402 real daily volume via
  x402scan / Artemis (public, NO Dune).
- **Settle:** **HELD** if ≥2 of the three ARR claims corroborate within a stated band AND x402
  real volume confirms small-but-nonzero. **FALSIFIED** if ARR is single-source-only OR x402 real
  volume ≈ 0 (pure wash). **INSUFFICIENT** otherwise.
- Level: L1-L2 (ARR is attested-third-party; x402 volume is on-chain-observable).

### C3 — The rails are real and adoptable *(build-time · deferred)*
- **Claim:** MCP (10k+ servers, Linux Foundation), x402 (LF, 22+ backers), ERC-8004 identity
  (~21.5k–45k registered).
- **Source-of-truth:** LF/AAF announcements + MCP registry; x402 LF + backer list; 8004scan
  registration count + a realness check (are mints speculative land-grab or active agents?).
- **Settle:** **HELD** if MCP+x402 governance/adoption confirmed AND ERC-8004 registrations are
  >X% non-speculative; nuance flagged. Run only if C1+C2 hold.

### C4 — Chain alignment *(build-time · deferred)*
- **Claim:** Base deepest (x402 ~85% of tx); XRPL institutional (RLUSD ~$1.6B mcap, AI Starter Kit
  June 2026); Berachain collapsed (~90% TVL, $3.3B→$270M).
- **Source-of-truth:** x402 chain split (x402scan); RLUSD mcap (CoinGecko, public); Berachain TVL
  (DeFiLlama, public). All zero-Dune.
- **Settle:** directional — confirm Base-leads + Berachain-collapsed (both cheaply checkable);
  XRPL flagged nascent. Run only if C1+C2 hold.

## Instruments
- **k-hole** (`/dig`, gemini-CLI subscription, `--model gemini-3-flash-preview` — Pro demoted to
  fallback after the 2026-06-12 doctor) for grounded practitioner/spec search.
- **BEACON** for any API-spec / MCP-discoverability output (the receipt or findings surface).
- **KRANZ** for cross-repo coordination (loa-finn spine ↔ score-api ↔ substrate) + the Dune
  cost-meter structure (via Asson's budget/pace watchdog — separate infra track).
- Public explorers (8004scan, x402scan, DeFiLlama, CoinGecko) — no Dune credits.

## What NOT to do
- NO build (no receipt prototype, no contract, no x402 integration) until C1+C2 settle GO.
- NO Dune credits (EXP-002 parked the Dune dependency; budget not topped up).
- NO promoting report claims to fact without an instrument confirming them.
- NO mid-run bars edits — a wrong settle criterion is a learning, not a patch.

## Verify
- Each cluster emits a settled verdict (HELD/FALSIFIED/INSUFFICIENT) citing its source-of-truth.
- C1+C2 produce a GO/NO-GO on the verification-void pivot, recorded on the spine as settle events.
- The settled-belief map directs (or kills) the staged build.
