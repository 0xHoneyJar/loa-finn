# GADGETS — the shop ledger

> One row per instrument. The fenced YAML block below is the machine source of
> truth; the table between the markers is GENERATED from it
> (`npx tsx src/lab/shop/ledger-check.ts --render`) — a stale table is a
> ledger-check failure. Status vocabulary is CLOSED: `CANDIDATE | KEEP | SELL |
> THROW` (lifecycle verdicts). Build maturity is a `check` fact, never a status.
> `SELL` is a shelf tag, not a sales channel (external revenue out of scope).

## Lifecycle (FR-6)

```
intake (idea/research/brief)
  → build   (the lab's compose lane, FAGAN-gated; or /implement inside a cycle)
  → check   (the test that binds it — declared contract: runner/target/args/timeout)
  → verdict (KEEP / SELL / THROW — a ledger row with evidence)
  → graduation (lab → src/ via /implement; row records src-imported)
```

Rigor floor (FR-7): no row without a runnable check; `contract: pending` is
visible debt, never a silent exemption. Shop tools carry `loc_ceiling` — growth
past the ceiling forces a split-or-graduate decision before merge.

## Ledger (machine source of truth)

```yaml
- id: gadget-001-realness-verdict
  what: SETTLE verdict math as a pure module (keep/sell/throw kernel)
  status: KEEP
  home: grimoires/loa/lab/gadgets/realness-verdict
  check: {runner: vitest, target: grimoires/loa/lab/gadgets/realness-verdict, args: [], exit: zero-is-pass, timeout_s: 120, contract: declared}
  graduation: pending
  evidence: {note: "built + 5/5 green 2026-06-14 (gadget-factory-brief); graduates to src/ via Corpus Engine FR-5"}
- id: metabolism-cartographer
  what: PSRO meta-solver (regret matching) with independent-witness self-check
  status: KEEP
  home: src/lab/metabolism/cartographer.ts
  check: {runner: vitest, target: src/lab/metabolism, args: [], exit: zero-is-pass, timeout_s: 180, contract: declared}
  graduation: src-imported
  evidence: {commit: "9ff050ae", note: "54/54 green re-verified 2026-07-12"}
- id: metabolism-hand
  what: Hand seam — ToyHand (deterministic CI) + CabtHand adapter (linux/amd64)
  status: KEEP
  home: src/lab/metabolism/hand.ts
  check: {runner: vitest, target: src/lab/metabolism, args: [], exit: zero-is-pass, timeout_s: 180, contract: declared}
  graduation: src-imported
  evidence: {commit: "9ff050ae"}
- id: metabolism-loop
  what: the PSRO toy loop — turns end-to-end on integer-domain receipts
  status: KEEP
  home: src/lab/metabolism/loop.ts
  check: {runner: vitest, target: src/lab/metabolism, args: [], exit: zero-is-pass, timeout_s: 180, contract: declared}
  graduation: src-imported
  evidence: {commit: "9ff050ae", note: "bd-ryza V1; real-cabt run pending (linux/amd64)"}
- id: metabolism-loyal-traitor
  what: exploitability measurement — blocks_convergence gate (the active anti-fox)
  status: KEEP
  home: src/lab/metabolism/loyal-traitor.ts
  check: {runner: vitest, target: src/lab/metabolism, args: [], exit: zero-is-pass, timeout_s: 180, contract: declared}
  graduation: src-imported
  evidence: {commit: "9ff050ae"}
- id: metabolism-ledger
  what: hash-chained metabolism receipts (custody stamps for matrix cells)
  status: KEEP
  home: src/lab/metabolism/metabolism-ledger.ts
  check: {runner: vitest, target: src/lab/metabolism, args: [], exit: zero-is-pass, timeout_s: 180, contract: declared}
  graduation: src-imported
  evidence: {commit: "9ff050ae"}
- id: metabolism-oracle
  what: best-response forge (deterministic parametric search, V1)
  status: KEEP
  home: src/lab/metabolism/oracle.ts
  check: {runner: vitest, target: src/lab/metabolism, args: [], exit: zero-is-pass, timeout_s: 180, contract: declared}
  graduation: src-imported
  evidence: {commit: "9ff050ae"}
- id: metabolism-population-ledger
  what: append-only content-addressed strategy population (the Archivist's shelf)
  status: KEEP
  home: src/lab/metabolism/population-ledger.ts
  check: {runner: vitest, target: src/lab/metabolism, args: [], exit: zero-is-pass, timeout_s: 180, contract: declared}
  graduation: src-imported
  evidence: {commit: "9ff050ae"}
- id: metabolism-verify
  what: independent re-checker — re-derives a run's claims, fail-closed (verify.py-equivalent)
  status: KEEP
  home: src/lab/metabolism/verify.ts
  check: {runner: vitest, target: src/lab/metabolism, args: [], exit: zero-is-pass, timeout_s: 180, contract: declared}
  graduation: src-imported
  evidence: {commit: "9ff050ae"}
- id: shop-cite-check
  what: citation validator — the self-legibility probe's primary gate
  status: KEEP
  home: src/lab/shop/cite-check.ts
  check: {runner: vitest, target: src/lab/shop, args: [], exit: zero-is-pass, timeout_s: 120, contract: declared}
  graduation: src-imported
  loc_ceiling: 220
  evidence: {note: "bd-1vp7 S1-T1.1; 16 tests incl dead/moved/dirty/symlink negatives"}
- id: shop-ledger-check
  what: gadget-ledger validator — closed enums, constrained runner, boundary reconcile, --render
  status: KEEP
  home: src/lab/shop/ledger-check.ts
  check: {runner: vitest, target: src/lab/shop, args: [], exit: zero-is-pass, timeout_s: 120, contract: declared}
  graduation: src-imported
  loc_ceiling: 200
  evidence: {note: "bd-1vp7 S1-T1.2; validates its own ledger (this file)"}
- id: shop-probe
  what: self-legibility probe runner — G1's instrument; appends probe-results.jsonl
  status: KEEP
  home: src/lab/shop/probe.ts
  check: {runner: vitest, target: src/lab/shop, args: [], exit: zero-is-pass, timeout_s: 120, contract: declared}
  graduation: src-imported
  loc_ceiling: 150
  evidence: {note: "bd-1vp7 S2-T2.4; dimension/class/dangling negatives tested"}
- id: shop-corpus-scrub
  what: corpus intake redaction gate — flatline secret patterns SoT, manifest hashes
  status: KEEP
  home: src/lab/shop/corpus-scrub.ts
  check: {runner: vitest, target: src/lab/shop, args: [], exit: zero-is-pass, timeout_s: 120, contract: declared}
  graduation: src-imported
  loc_ceiling: 100
  evidence: {note: "bd-1vp7 S2-T2.1; refuses to scrub blind; raw hashes retained, raws deleted"}
- id: candidate-002-survival-forecaster
  what: survival-forecast service over the realness filter (gadget-factory-brief #002)
  status: CANDIDATE
  home: grimoires/loa/context/gadget-factory-brief.md
  check: {runner: vitest, target: grimoires/loa/context/gadget-factory-brief.md, args: [], exit: zero-is-pass, timeout_s: 60, contract: pending}
  graduation: pending
  evidence: {note: "brief only — external-revenue gadgets explicitly out of V1 scope"}
- id: candidate-003-realness-score
  what: realness-score service (gadget-factory-brief #003)
  status: CANDIDATE
  home: grimoires/loa/context/gadget-factory-brief.md
  check: {runner: vitest, target: grimoires/loa/context/gadget-factory-brief.md, args: [], exit: zero-is-pass, timeout_s: 60, contract: pending}
  graduation: pending
  evidence: {note: "brief only — don't sell the loupe; the track record is the franchise"}
```

## Shelf view (generated — do not edit by hand)

<!-- ledger-table:start -->
| id | what | status | runner | contract | graduation |
|---|---|---|---|---|---|
| gadget-001-realness-verdict | SETTLE verdict math as a pure module (keep/sell/throw kernel) | KEEP | vitest | declared | pending |
| metabolism-cartographer | PSRO meta-solver (regret matching) with independent-witness self-check | KEEP | vitest | declared | src-imported |
| metabolism-hand | Hand seam — ToyHand (deterministic CI) + CabtHand adapter (linux/amd64) | KEEP | vitest | declared | src-imported |
| metabolism-loop | the PSRO toy loop — turns end-to-end on integer-domain receipts | KEEP | vitest | declared | src-imported |
| metabolism-loyal-traitor | exploitability measurement — blocks_convergence gate (the active anti-fox) | KEEP | vitest | declared | src-imported |
| metabolism-ledger | hash-chained metabolism receipts (custody stamps for matrix cells) | KEEP | vitest | declared | src-imported |
| metabolism-oracle | best-response forge (deterministic parametric search, V1) | KEEP | vitest | declared | src-imported |
| metabolism-population-ledger | append-only content-addressed strategy population (the Archivist's shelf) | KEEP | vitest | declared | src-imported |
| metabolism-verify | independent re-checker — re-derives a run's claims, fail-closed (verify.py-equivalent) | KEEP | vitest | declared | src-imported |
| shop-cite-check | citation validator — the self-legibility probe's primary gate | KEEP | vitest | declared | src-imported |
| shop-ledger-check | gadget-ledger validator — closed enums, constrained runner, boundary reconcile, --render | KEEP | vitest | declared | src-imported |
| shop-probe | self-legibility probe runner — G1's instrument; appends probe-results.jsonl | KEEP | vitest | declared | src-imported |
| shop-corpus-scrub | corpus intake redaction gate — flatline secret patterns SoT, manifest hashes | KEEP | vitest | declared | src-imported |
| candidate-002-survival-forecaster | survival-forecast service over the realness filter (gadget-factory-brief | CANDIDATE | vitest | pending | pending |
| candidate-003-realness-score | realness-score service (gadget-factory-brief | CANDIDATE | vitest | pending | pending |
<!-- ledger-table:end -->
