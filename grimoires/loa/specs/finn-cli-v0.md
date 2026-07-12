---
status: spec-for-ratification
date: 2026-07-12
bead: bd-1vp7 (S3-T3.3; build = S4, GATED on S1-S3 aggregate green)
traces: sdd-narrative-historical-architecture.md §2.6 · prd rev2 FR-8/FR-9
---

# finn-cli v0 — spec (ratify at PR review)

> The composition surface: finn's identity and discipline as verbs, slotting in
> beside freeside-cli/loa-cli. **The CLI owns no state — it reads the ledgers**
> (claim inventory, GADGETS, corpus provenance, probe-results.jsonl, SETTLES).
> v0 build = `doctor` + `gadgets` only.

## Verbs

### `finn doctor` (v0)
- **Reads:** `grimoires/loa/identity/claim-inventory.yaml` ·
  `grimoires/loa/lab/GADGETS.md` · `grimoires/loa/lab/corpus/*/provenance.yaml` ·
  `grimoires/loa/lab/probe-results.jsonl` (persisted by probe.ts — CLI never runs the probe).
- **Does:** cite-check the inventory; ledger-check reconcile; corpus tier census;
  surface the LAST probe result (red iff failed or absent).
- **Output:** human table; `--json` = `{schema_version: 1, checks: {...}, pass}`.
- **Exit:** 0 all green · 1 any red · 2 usage.

### `finn gadgets [id]` (v0)
- **Reads:** the GADGETS.md YAML block (via ledger-check's parser — one parser).
- **Does:** list rows (id/status/contract/graduation) or show one; `--run-check <id>`
  executes the row's check UNDER ITS CONTRACT (constrained runner + argv + timeout —
  never a shell string).
- **Exit:** list/show 0 · `--run-check` = the check's exit · unknown id 2.

### `finn consult <subject> -q <questions.yaml>` (V2 — spec'd, not v0)
- Scaffolds a testimony record per `grimoires/loa/lab/CONSULTATIONS.md`
  (pre-registered questions in, template out); the SETTLE side shells cite-check.
- **Refusal:** person subjects without an ethics header in their roster brief →
  exit 3, no scaffold (the consent gate, mechanized).

### `finn settles` (V2)
- Lists `grimoires/loa/lab/SETTLES.md` verdicts + evidence links. Read-only.

## Privacy filter (all verbs, mechanical)

Output NEVER includes body content from sources whose provenance is
`privacy: internal-only` — citations/metadata only, via the shared refOnly
formatter (SDD §4). A verb that would need raw corpus content is out of contract.

## Error semantics (all verbs)

| Class | Exit | Behavior |
|---|---|---|
| green | 0 | normal output |
| red finding | 1 | findings on stdout (`--json` stable shape), no partial writes |
| usage / unknown id | 2 | usage to stderr |
| consent refusal | 3 | one-line reason, nothing else |
| substrate missing (no ledger/inventory) | 4 | names the missing artifact + the sprint that builds it |

## Packaging & slot-in

v0: `npx finn` bin in this repo (like freeside-cli's incur pattern), zero new
deps, reads only. Loa-launcher integration (`loa run finn …`) is V2+ — the
launcher contract is a follow-up conversation with loa-cli's owner; nothing in
v0 assumes it.

## Non-goals (v0)

No writes, no network, no probe execution, no consult scaffolding, no daemon,
no config file of its own. The CLI is a window, not a hand.
