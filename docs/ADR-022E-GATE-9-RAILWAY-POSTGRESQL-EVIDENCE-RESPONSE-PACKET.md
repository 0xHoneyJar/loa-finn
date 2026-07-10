# ADR-022E Gate #9 — Railway PostgreSQL Evidence Response Packet (Finn)

**Status**: Docs-only evidence response (Phase 49M)
**Date**: 2026-07-02
**Owner repo**: `loa-finn`
**Counterparty**: `loa-straylight`
**Authorizing dispatch**: Loa-Straylight Phase 49L (merged) — bounded docs-only sibling-owner evidence PR authorization for Straylight gate #9
**Request topic shape**: Straylight Phases 49J / 49K / 49L
**Predecessors in this repo**:
- [`docs/STRAYLIGHT-ADR-022E-GATE-9-OWNER-RESPONSE-ACCEPTANCE.md`](STRAYLIGHT-ADR-022E-GATE-9-OWNER-RESPONSE-ACCEPTANCE.md)
- [`docs/STRAYLIGHT-ADR-022E-GATE-9-RUNTIME-EVIDENCE-LANE-AUTHORIZATION-GATE.md`](STRAYLIGHT-ADR-022E-GATE-9-RUNTIME-EVIDENCE-LANE-AUTHORIZATION-GATE.md)
- [`docs/STRAYLIGHT-ADR-022E-GATE-9-RUNTIME-EVIDENCE-RESULT.md`](STRAYLIGHT-ADR-022E-GATE-9-RUNTIME-EVIDENCE-RESULT.md)

---

## 1. What This Document Is

This is the Finn-side **docs-only evidence response** to the Loa-Straylight Phase 49L dispatch authorization. Phase 49L merged in `loa-straylight` and authorized the later opening of bounded docs-only sibling evidence PRs from Finn and Dixie for Straylight gate #9. This packet is Finn's response artifact for that dispatch. It records evidence and posture only.

## 2. What This Document Is Not

This document, and the PR that carries it, explicitly does **not**:

- claim Straylight gate #8 is satisfied;
- claim Finn gate #9 is satisfied;
- claim Dixie gate #10 is satisfied;
- claim Railway PostgreSQL is accepted;
- select a host;
- select a production database;
- propose an adapter;
- authorize implementation;
- authorize production wiring;
- implement anything.

It also carries a strict no-leak posture: no credentials, tokens, keys, connection strings, endpoints, hostnames, ports, account/project identifiers, regions, topology, env-var values, pricing, deployment steps, or implementation guidance appear in this packet or its companion documents.

## 3. Response to the Phase 49J/49K/49L Request Topic Shape

### 3.1 Runtime/evidence posture relative to Railway PostgreSQL as recommended candidate class

Finn's runtime already contains a **feature-flagged, fail-closed PostgreSQL integration path** (managed via Drizzle ORM, disabled by default) that is host-agnostic: nothing in Finn's source binds it to any particular managed-PostgreSQL provider, Railway included. Finn's posture toward the Railway PostgreSQL *candidate class* is therefore: **compatible in kind, uncommitted in fact**. The detailed local citations are in the companion document [`docs/ADR-022E-GATE-9-FINN-RUNTIME-BOUNDARY-EVIDENCE.md`](ADR-022E-GATE-9-FINN-RUNTIME-BOUNDARY-EVIDENCE.md). Finn records no acceptance, endorsement, or selection of Railway PostgreSQL; candidate evaluation authority remains with Straylight.

### 3.2 No semantic ownership creep into Finn

Finn's existing PostgreSQL surface stores Finn-local operational records only (see companion evidence document §3). Finn does not define, and this packet does not propose that Finn define, any canonical-store semantics on Straylight's behalf. The no-creep claim in this section is supportable **for the PostgreSQL storage surface** specifically.

Scope qualification: the predecessor evidence result ([`docs/STRAYLIGHT-ADR-022E-GATE-9-RUNTIME-EVIDENCE-RESULT.md`](STRAYLIGHT-ADR-022E-GATE-9-RUNTIME-EVIDENCE-RESULT.md) §9) documents two **unresolved** semantic-ownership-creep findings on other surfaces — `TIER_TRUST_MAP` (`src/hounfour/economic-boundary.ts`) and `CRITICAL_ACTIONS` (`src/hounfour/audit/buffered-audit-chain.ts`) locally *define* classifications rather than enforcing externally-supplied ones — and those findings are part of why that result is `PARTIAL` and gate #9 remains held. This packet does not claim they are resolved; resolving them would be implementation, which is out of scope here. The statement that Finn's role is **enforce/emit/persist under externally-defined semantics — never canonical semantic ownership** is therefore recorded as Finn's *committed target posture* for any future authorized lane, with the two documented creep findings still requiring separate treatment before Finn could host the gate #9 responsibility cleanly.

### 3.3 Preservation of Straylight as semantic owner of the canonical-store boundary

Recorded and reaffirmed: **Straylight is and remains the semantic owner of the canonical-store boundary.** Nothing in Finn's repository claims that ownership, and a repo-wide source inspection confirms zero `Straylight` / `ADR-022E` coupling in Finn's `src/` tree (see companion evidence document §4). Finn cannot drift into ownership it is not wired to.

### 3.4 No-leak posture

This packet and both companion documents contain no credentials, tokens, API keys, database URLs, connection strings, deployment endpoint URLs, deployment hostnames, ports, account IDs, project IDs, regions, topology details, env-var values, curl/API examples, pricing, deployment steps, adapter designs, or production wiring instructions. Where Finn's source contains configuration surfaces, this response cites them by file path only and describes their *shape*, never their values.

### 3.5 Runtime interoperability posture

Finn's runtime interoperates with a PostgreSQL-class substrate through a narrow, replaceable seam: a single connection factory, a boot-time feature flag that fails closed when enabled without configuration, boot-time schema validation, and a dedicated PostgreSQL schema namespace isolating Finn's tables from other services. This shape means a future Straylight-directed canonical-store substrate would not have to contend with Finn-global assumptions about any specific host. Details and citations are in the companion evidence document.

### 3.6 Railway-specific residual gaps affecting the Finn boundary

From Finn's boundary, the residual gaps specific to the Railway PostgreSQL candidate class are all **unverifiable from within this repository**:

- Finn's source carries no Railway-specific coupling; historical Railway deployment configuration was deliberately removed from the repo in a prior cleanup sprint, so Finn cannot cite any live Railway-side artifact.
- Managed-provider operational properties (durability guarantees, backup/restore behavior, failover, version pinning, network isolation) are provider-side facts. Finn can neither confirm nor deny them locally and defers their evaluation entirely to Straylight's candidate assessment.
- Any interaction contract between a provider-managed PostgreSQL instance and Straylight's canonical-store semantics is Straylight's to define; Finn records no assumption about it.

### 3.7 What Finn can prove, cannot prove, or must defer

Summarized here; itemized with citations in the companion evidence document §§3–7:

- **Can prove locally**: existence and shape of a host-agnostic, feature-flagged, fail-closed PostgreSQL integration path; schema-namespace isolation; WAL-first durability posture; enforce-not-define runtime boundary surfaces; absence of Straylight/ADR-022E coupling in source.
- **Cannot prove locally**: anything about any specific provider's operational behavior; anything about Straylight's gate #8 state; anything about Dixie's boundary posture; suitability of Finn's existing schema or persistence surfaces for canonical-store duty.
- **Must defer**: canonical-store semantics and candidate acceptance (to Straylight); sibling boundary evidence (to Dixie); host/adapter properties (to a later production host/adapter decision that is not proposed here).

### 3.8 Whether any Finn-side artifact is needed before Straylight candidate acceptance authority can be requested

**Finn's answer: no new Finn-side artifact is needed beyond this evidence response.** Finn's locally provable posture is fully recorded in this packet and its companions; nothing further can be produced from this repository without crossing into forbidden implementation or overclaiming provider-side facts. If Straylight's intake later determines that additional Finn evidence is required, that would need a new, separately authorized docs-only dispatch — it is not pre-authorized here.

## 4. Result

**Result token**: `FINN_GATE_9_RAILWAY_POSTGRESQL_EVIDENCE_RESPONSE_RECORDED`

This packet records the Finn-side evidence response. It advances no gate by itself. Intake, evaluation, and any subsequent request for candidate acceptance authority occur in `loa-straylight`.
