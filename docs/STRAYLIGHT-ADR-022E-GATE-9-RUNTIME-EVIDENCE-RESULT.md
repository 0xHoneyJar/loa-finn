# loa-finn Runtime Evidence Result — Loa-Straylight ADR-022E Gate #9

**Status**: Evidence/result record (docs-only) — **result: `PARTIAL`**, gate #9 remains held
**Date**: 2026-06-26
**Owner repo**: `loa-finn`
**Counterparty**: `loa-straylight`
**Upstream phase**: Loa-Straylight Phase 48L (merged)
**Authorizing gate**: [`docs/STRAYLIGHT-ADR-022E-GATE-9-RUNTIME-EVIDENCE-LANE-AUTHORIZATION-GATE.md`](STRAYLIGHT-ADR-022E-GATE-9-RUNTIME-EVIDENCE-LANE-AUTHORIZATION-GATE.md)
**Predecessor**: [`docs/STRAYLIGHT-ADR-022E-GATE-9-OWNER-RESPONSE-ACCEPTANCE.md`](STRAYLIGHT-ADR-022E-GATE-9-OWNER-RESPONSE-ACCEPTANCE.md)

---

## 1. What This Document Is

This is the `loa-finn` **evidence/result** artifact for the ADR-022E gate #9 runtime evidence lane that PR #195 authorized and decomposed. It is the *separate evidence PR* anticipated by the authorization gate's §5 and §14.

It is **evidence and result only**, not implementation. It inspects existing `loa-finn` runtime/enforcement surfaces read-only, cites them by `file:line`, and answers — under teammate review — whether `loa-finn` can provide evidence for the gate #9 runtime/enforcement responsibility. It does **not** add, modify, or wire any behavior. Every claim below is grounded in a concrete citation that a reviewer can open and check.

## 2. Scope and Result

- **docs-only** — this change creates exactly one Markdown document and nothing else.
- **evidence/result only** — it argues from existing surfaces; it does not design, implement, or authorize behavior.
- **scope is gate #9 (runtime) only** — the sibling `loa-dixie` gate #10 boundary evidence lane is a separate artifact in a different repo and is out of scope here.

> **Result: `PARTIAL`.**
>
> `loa-finn` already demonstrates a genuine, citable **emit/enforce-not-define** runtime capability across multiple surfaces, which is the *kind* of responsibility gate #9 needs. But the evidence is **incomplete** for a full `PASS`: (a) there is **no existing Straylight-bound wiring surface** in `src/` (zero `Straylight`/`ADR-022E` coupling), so no surface *already* discharges the specific gate #9 responsibility, and producing one would require forbidden implementation; and (b) two surfaces show **semantic-ownership creep** that would have to be resolved before `loa-finn` could host the responsibility without becoming a canonical semantic owner. Gate #9 stays **held**.

## 3. Upstream Authorization Context

Per Phase 48L (merged) and the authorization gate (PR #195):

- gate #9 owner response: `ACCEPT_RECORDED` — `loa-finn` is the willing owner of the *future candidate* runtime evidence lane, under teammate review.
- gate #10 owner response: `ACCEPT_RECORDED` (sibling, `loa-dixie`, out of scope here).
- #9/#10 owner-response routing completion: `RECORDED`.
- The authorization gate fixed the **evidence question** (§4), the **PASS criteria** (its §9), the **fail-closed criteria** (its §10), the **allowed surfaces** (its §11), and the **forbidden surfaces** (its §12). This document is measured against those.

## 4. Evidence Question

> Can `loa-finn` provide evidence, under teammate review, for the ADR-022E gate #9 runtime/enforcement responsibility that Loa-Straylight needs before the broader MVP-2 Admission Wedge D.1 / gate #8 chain can advance?

The implicated responsibility is, in `loa-finn`'s own terms: **to host runtime/enforcement choke points that emit and enforce decisions — access, economic, billing-conservation, cost/verdict, audit — that an external owner *defines*, while persisting and recovering the evidence of those decisions, without `loa-finn` becoming the canonical semantic owner of the definitions.**

## 5. Method: Read-Only Inspection

Inspection used only read-only commands (`git grep`, `grep`, `nl`, `sed -n`, `cat`). Six candidate runtime surfaces named by the authorization gate were inspected in parallel, then the strongest citations were independently spot-checked against the PASS/fail-closed criteria. No source, test, config, or state file was modified. The controlling cross-cutting check:

```
git grep -in -e 'straylight' -e 'ADR-022E' -e 'estate' -- 'src/**'
```

returns **no Straylight / ADR-022E / estate-semantic matches** in `src/` (the only hits are unrelated tokens such as `restoreState`, `saveState`, `preState`). This is load-bearing: it means `loa-finn` carries the generic *enforcement capability* but holds **no existing surface bound to Straylight's gate #9 contract**.

## 6. Implicated Finn Runtime/Enforcement Surfaces

The responsibility is implicated across these existing surfaces (all relevant; cron is the partial exception):

- **`src/gateway/`** — request-surface access enforcement (allowlist, bearer/API-key auth, payment-decision routing, CSRF). Enforces externally-stored policy.
- **`src/hounfour/`** — economic-boundary middleware, pool-claim enforcement, wire-boundary parsing, billing-conservation guard, rate limiting, buffered audit chain. The richest enforce-vs-define surface.
- **`src/cost/` + `src/score/`** — deterministic cost-atom metering and the score-verdict gate (`decideGate`) plus substrate-agnostic scoring core.
- **`src/safety/`** — GitHub mutation firewall, hash-chained audit trail, boot validation, secret redaction, alert emission. Pure enforce/emit/telemetry.
- **`src/persistence/`** — WAL append, R2/git sync, recovery, pruning. Stores/recovers opaque data; not a canonical-store host selection.
- **`src/cron/`** — circuit-breaker, kill-switch, sandbox, concurrency, rate limiting. Runtime guards, but they **define** their own local domain (failure taxonomy, sandbox allowlist) rather than enforcing externally-defined policy — least aligned with gate #9.

## 7. Evidence Table (file:line citations)

| Surface | Citation | Kind | What it shows |
|---------|----------|------|---------------|
| Gateway | `src/gateway/allowlist.ts:61-72` | enforces | `isAllowed()` checks a Redis-backed allowlist; enforces policy stored elsewhere, does not define it. |
| Gateway | `src/gateway/auth.ts:15-33` | enforces | Bearer-token check against `config.auth.bearerToken`; token supplied via `FinnConfig`, not owned here. |
| Gateway | `src/gateway/payment-decision.ts:84-130` | enforces | Payment-routing decision tree over `deps.freeEndpoints` + credentials; policy is given, not defined. |
| Gateway | `src/gateway/api-keys.ts:93-148` | enforces | API-key validation via bcrypt + Redis; key/revocation/balance policy lives in external store. |
| Hounfour | `src/hounfour/wire-boundary.ts:58-103` | enforces | `parseMicroUSD()` is the sole constructor; enforces canonical wire format + DoS bounds at ingress. |
| Hounfour | `src/hounfour/wire-boundary.ts:161-165` | enforces | `assertMicroUSDFormat()` fail-closes non-canonical values at the persistence egress boundary. |
| Hounfour | `src/hounfour/economic-boundary.ts:451` | enforces | `evaluateBoundary()` delegates to the upstream protocol's `evaluateEconomicBoundary()` — Finn applies, does not define, the verdict. |
| Hounfour | `src/hounfour/economic-boundary.ts:626-637` | enforces | Middleware returns `403 ECONOMIC_BOUNDARY_DENIED` (enforce mode) on `!granted`; mode-aware (shadow allows). |
| Hounfour | `src/hounfour/pool-enforcement.ts:87-160` | enforces | `enforcePoolClaims()` pure function validates pool_id/tier/`allowed_pools`; returns ok/error discriminant. |
| Hounfour | `src/hounfour/billing-conservation-guard.ts:413-506` | enforces | `runCheck()` dual-layer fail-closed lattice; `effective='fail'` if either evaluator fails. |
| Cost | `src/gateway/routes/score-verdict.ts:97-133` | enforces | `decideGate()` enforces a 6-row predicate order over `band`/`claim_verdict` it **receives** from the score producer; fail-closed catch-all. |
| Cost | `src/cost/cost-atom.ts:346-394` | enforces | `closeAtom()` enforces the sum invariant; totals computed deterministically, immutable once closed. |
| Score | `src/score/edge/port.ts:29-36` | boundary-marker | `TxGraph` is the substrate-agnostic seam; core consumes abstract edges, never couples to estate specifics. |
| Safety | `src/safety/github-firewall.ts:123-241` | enforces | `enforce()` 9-step pipeline enforces registry policy and emits audit records; receives policy, does not define it. |
| Safety | `src/safety/audit-trail.ts:878-953` | emits | `appendRecord()` emits immutable hash-chained, write-ahead audit records; does not define tool semantics. |
| Persistence | `src/persistence/recovery.ts:177-226` | emits | `runRecovery()` delegates recovery priority/strategy to the upstream `RecoveryEngine`; Finn assembles sources. |
| Persistence | `src/persistence/wal.ts:68-115` | enforces | `WAL.append()` enforces disk-pressure hysteresis + atomic write; treats stored data as opaque. |
| **Hounfour (creep)** | `src/hounfour/economic-boundary.ts:56-61` | **defines-domain-semantics** | `TIER_TRUST_MAP` authoritatively maps tier → `reputation_state` + blended score — a domain contract, not enforcement of a given policy. |
| **Hounfour (creep)** | `src/hounfour/audit/buffered-audit-chain.ts:40` | **defines-domain-semantics** | `CRITICAL_ACTIONS` locally defines which actions require fail-closed audit, rather than receiving that classification. |

## 8. Runtime Responsibility Analysis

The gate #9 responsibility is fundamentally an **enforcement-and-evidence** responsibility, and `loa-finn` already hosts that *shape* of responsibility at production-grade choke points:

- **Decisions are received and enforced, not authored.** The economic boundary composes Finn's local JWT/budget state into snapshots, then calls the upstream protocol's `evaluateEconomicBoundary()` (`src/hounfour/economic-boundary.ts:451`) and enforces the returned verdict with a `403` (`src/hounfour/economic-boundary.ts:626-637`). This is the canonical emit/enforce pattern: the *definition* of what is economically admissible lives upstream; Finn *applies* it.
- **Enforcement is fail-closed and mode-aware.** The boundary runs in `bypass | shadow | enforce` modes; in `enforce` it denies (`403`) on policy failure and returns `503` on infrastructure error rather than silently passing — the gate is not bypassed on the unhappy path.
- **Evidence is emitted and persisted.** The safety audit trail emits write-ahead, hash-chained records before/after every mutation (`src/safety/audit-trail.ts:878-953`), the firewall records intents/results/denials (`src/safety/github-firewall.ts:123-241`), and the WAL/recovery stack persists and recovers that evidence while treating the payload as opaque (`src/persistence/wal.ts:68-115`, `src/persistence/recovery.ts:177-226`).
- **Deterministic verdicts are enforced, not defined.** `decideGate()` (`src/gateway/routes/score-verdict.ts:97-133`) enforces a ratified predicate order over `band`/`claim_verdict` values it *receives* from the score producer, fail-closing on any missing/invalid input.

This establishes that `loa-finn` **can host** the runtime/enforcement responsibility as a mechanism. What it does **not** establish is that any existing surface *already discharges the specific gate #9 contract* — because no Straylight-bound surface exists yet (§5). Building that binding is implementation, which this evidence lane is forbidden from doing.

## 9. Finn-vs-Straylight Semantic-Boundary Analysis

The decisive gate #9 question (authorization gate §7.3–§7.4) is whether `loa-finn` can host/enforce **without becoming the canonical semantic owner** and whether **Finn emits/enforces what Straylight defines** rather than redefining estate semantics.

**Where the boundary holds (majority of surfaces):**

- `wire-boundary.ts` parses formats the protocol package defines; `src/hounfour/protocol-types.ts:1-12` re-exports types *from* `@0xhoneyjar/loa-hounfour` rather than authoring them. The economic boundary *delegates* the admissibility decision to the upstream evaluator (`src/hounfour/economic-boundary.ts:451`). The gateway enforces allowlist/auth/payment policy stored in Redis/config/DB. The score core consumes an abstract `TxGraph` port (`src/score/edge/port.ts:29-36`) and never couples to estate specifics. On all of these, **Finn emits/enforces what an external owner defines** — exactly the gate #9 posture.

**Where the boundary is crossed (the two blockers):**

- `TIER_TRUST_MAP` (`src/hounfour/economic-boundary.ts:56-61`) authoritatively *defines* the tier → reputation-state contract and blended-score baselines locally, rather than receiving that mapping as a runtime input. Tier classification is estate/domain semantics; Finn owning it authoritatively is **ownership creep**.
- `CRITICAL_ACTIONS` (`src/hounfour/audit/buffered-audit-chain.ts:40`) *defines* which actions are "critical" for fail-closed audit, rather than enforcing a classification it is given.

Neither is bound to Straylight today (they are Finn-local), so neither *redefines Straylight estate semantics* right now. But they demonstrate that the surface closest to the gate #9 responsibility (the economic boundary) currently mixes *enforce* with *define*. For a full `PASS`, that mix would have to be separated so the tier→reputation contract and the critical-action set arrive as Straylight-defined runtime inputs. That separation is implementation — out of scope here.

**Conclusion:** `loa-finn` **emits/enforces what an upstream owner defines on most surfaces**, and is architecturally capable of hosting the gate #9 responsibility without becoming the canonical semantic owner — but it does not yet *cleanly* do so on the economic-boundary surface, and no Straylight-bound surface exists. Hence `PARTIAL`, not `PASS`.

## 10. Pass / Partial / Fail-Closed Assessment

Measured against the authorization gate's criteria:

**PASS criteria (its §9) — not all met:**

- ✅ Identifies the exact implicated runtime/enforcement surface with cited refs (§6, §7).
- ⚠️ Shows Finn *can* host/enforce without becoming canonical semantic owner *in general* — but `TIER_TRUST_MAP` and `CRITICAL_ACTIONS` are unresolved creep on the most relevant surface.
- ⚠️ Shows Finn emits/enforces what an external owner defines on most surfaces — but no **Straylight-bound** surface exists to demonstrate the *specific* gate #9 discharge.
- ✅ Stays within allowed surfaces (docs-only + read-only citation); touches no forbidden surface.
- ✅ Produces an intakeable return artifact (§12).
- ✅ Does not overclaim (§11 preserved blocked state).

**Fail-closed criteria (its §10) — none fully triggered, but two partials:**

- Cited surfaces *do* support the enforcement-capability claim, so this is **not** a "cannot cite / citations unsupported" fail-closed.
- Does **not** touch forbidden surfaces, implement behavior, wire production, select a canonical-store physical host, or propose a production adapter.
- Does **not** attempt to discharge gate #8, satisfy D.1, start D.2, or close MVP-2.
- The evidence is **incomplete** (no Straylight binding; residual semantic creep), which is the boundary between PASS and fail-closed.

**Result: `PARTIAL`.** Real, citable enforcement surfaces exist and the emit/enforce-not-define posture is largely demonstrable, but the specific gate #9 discharge is absent because (1) no Straylight-bound wiring exists and (2) semantic-ownership creep remains on the economic-boundary surface. Neither can be remedied within an evidence-only lane. **`FAIL_CLOSED` is not asserted** — the surfaces and the posture are real — but a `PASS` would overclaim. Gate #9 stays **held**.

## 11. Preserved Blocked State (Non-Claims)

This evidence/result document, by itself:

- does **not** satisfy ADR-022E:58.
- does **not** discharge gate #8.
- does **not** satisfy D.1.
- does **not** start D.2.
- does **not** close MVP-2.
- does **not** select a canonical-store physical host.
- does **not** propose a production adapter.
- does **not** make `loa-finn` the canonical semantic owner of any Loa-Straylight estate semantics.
- does **not** authorize implementation, production wiring, or source/test/config/runtime/migration/DB changes.
- does **not** claim gate #9 satisfaction, nor that the runtime responsibility is fully discharged.

Gate #9 remains **held**; gate #8 remains undischarged; D.1 remains unsatisfied; D.2 is not started; MVP-2 remains open. `loa-straylight` remains responsible for its own intake and posture transitions after reviewing this evidence; this artifact is an input to that process, not a substitute for it.

## 12. Return Artifact for loa-straylight Intake

| Field | Value |
|-------|-------|
| Owner repo | `loa-finn` |
| Counterparty | `loa-straylight` |
| Gate | ADR-022E sibling gate #9 — runtime evidence lane (evidence/result) |
| Upstream | Phase 48L (merged); #9 owner-response `ACCEPT_RECORDED`; routing `RECORDED`; authorized by PR #195 |
| Evidence question | Can `loa-finn` provide evidence, under teammate review, for the gate #9 runtime/enforcement responsibility before the MVP-2 Admission Wedge D.1 / gate #8 chain advances? |
| **Result** | **`PARTIAL`** — gate #9 held |
| Strongest supporting evidence | Delegated economic-boundary enforcement (`src/hounfour/economic-boundary.ts:451`, `src/hounfour/economic-boundary.ts:626-637`); deterministic verdict gate (`src/gateway/routes/score-verdict.ts:97-133`); hash-chained audit emission (`src/safety/audit-trail.ts:878-953`); opaque persistence/recovery (`src/persistence/wal.ts:68-115`, `src/persistence/recovery.ts:177-226`) |
| Blocking gaps | No Straylight-bound wiring surface in `src/` (zero coupling); semantic-ownership creep in `TIER_TRUST_MAP` (`src/hounfour/economic-boundary.ts:56-61`) and `CRITICAL_ACTIONS` (`src/hounfour/audit/buffered-audit-chain.ts:40`) |
| Semantic-boundary conclusion | Finn emits/enforces what an upstream owner defines on most surfaces and is capable of hosting gate #9 without canonical semantic ownership, but does not yet do so cleanly on the economic-boundary surface |
| Does **not** | satisfy ADR-022E:58, gate #9, or D.1; discharge gate #8; start D.2; close MVP-2; select a canonical-store physical host; propose a production adapter; authorize implementation or production wiring; make Finn the canonical semantic owner |
| Intake hint | `loa-straylight` may intake this as the recorded `loa-finn` gate #9 runtime evidence result (`PARTIAL`); it does not advance the chain on its own |

## 13. Selected Next Step

- The honest next step, **if `loa-straylight` accepts this `PARTIAL`**, is a **future, separate implementation-authorization gate** (not opened here) that would scope: (a) accepting the tier→reputation contract and critical-action classification as Straylight-defined *runtime inputs* (resolving the creep in §9), and (b) wiring a Straylight-bound enforcement surface into `src/` so a real gate #9 discharge surface exists.
- Until such a gate is opened and itself passes teammate review, **no** implementation, wiring, storage, schema, or production work may begin. This document does **not** pre-authorize that gate; it only reports what the existing evidence supports.
- `loa-straylight` decides its own posture from here. Gate #9 stays held pending that decision.
