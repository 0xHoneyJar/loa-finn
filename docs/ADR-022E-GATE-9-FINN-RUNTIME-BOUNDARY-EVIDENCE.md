# ADR-022E Gate #9 — Finn Runtime Boundary Evidence

**Status**: Docs-only evidence record (Phase 49M)
**Date**: 2026-07-02
**Owner repo**: `loa-finn`
**Companion packet**: [`docs/ADR-022E-GATE-9-RAILWAY-POSTGRESQL-EVIDENCE-RESPONSE-PACKET.md`](ADR-022E-GATE-9-RAILWAY-POSTGRESQL-EVIDENCE-RESPONSE-PACKET.md)

---

## 1. What This Document Is

A read-only inspection record of `loa-finn`'s runtime/boundary posture relevant to a **future** Straylight canonical-store substrate. All file and line references below were verified against the working tree at the time of writing. Where a claim could not be verified locally, it is recorded as negative evidence, unknown, or deferral rather than asserted. This document implements nothing and selects nothing.

## 2. Method

Inspection used only read-only commands (`git grep`, `grep`, `nl`, `sed -n`, `ls`). No source, test, config, or state file was modified. Line references cite the file as inspected; reviewers should treat them as anchors, not immutable coordinates.

## 3. What Finn Can Prove Locally

### 3.1 A feature-flagged, fail-closed, host-agnostic PostgreSQL integration path exists

- `src/index.ts:66-84` — PostgreSQL initialization is gated behind a boot-time feature flag (`config.postgres.enabled`). When the flag is enabled but no connection configuration is present, boot **throws** (fail-closed) rather than degrading silently (`src/index.ts:70-72`). When disabled, the runtime logs that PostgreSQL is off and continues on its default persistence path (`src/index.ts:82-84`). After connecting, the runtime runs a boot-time database validation step (`src/index.ts:81`, implemented in `src/drizzle/validate.ts`). Coverage qualification: `validateDatabase()` verifies only three required base tables (`src/drizzle/validate.ts:7-11` — `finn_api_keys`, `finn_billing_events`, `finn_verification_failures`), while `src/drizzle/schema.ts` declares additional tables (personalities, credits, nonces, events, experience snapshots) that the checked-in migrations do not create and boot validation does not check. The fail-closed property is therefore proven **for the validated base tables only**; PostgreSQL-backed surfaces beyond them (e.g. the personality store) can pass boot validation and encounter missing tables later at query time.
- `src/config.ts:311-315` — the `postgres` configuration block reads its enablement flag, connection reference, and pool size from the process environment at boot. No connection values are baked into the runtime source. (A development-only default exists in the migration tooling config `drizzle.config.ts`; it is a local-development convenience in tooling, not a runtime binding, and its value is deliberately not reproduced here.)
- `src/drizzle/db.ts:18-28` — a single connection factory (`createDb`) is the construction point for the **runtime service's** database client (Drizzle ORM over the `postgres` driver, with bounded pool size and connect/idle timeouts). Nothing in this factory references any specific hosting provider. Seam qualification: the standalone migration runner constructs its own client directly (`src/drizzle/migrate.ts:17-20`), bypassing `createDb`, so a future host/provider change would touch **two** database-client construction points (runtime factory + migration runner), not one.

### 3.2 Schema-namespace isolation

- `src/drizzle/schema.ts:2,7` — all Finn tables are declared inside a dedicated PostgreSQL schema namespace (`pgSchema("finn")`), documented in-source as "isolated from other services." The tables defined there are Finn-local operational records (e.g., API-key records at `src/drizzle/schema.ts:11-24`, an append-only billing-event ledger beginning at `src/drizzle/schema.ts:28`). None of them claim canonical-store semantics for any external system.
- `drizzle/` — exactly three checked-in migration files exist (`0000_*.sql`, `0001_*.sql`, `0002_*.sql`), managed by Drizzle Kit (`drizzle.config.ts`), with a standalone migration entrypoint at `src/drizzle/migrate.ts` that refuses to run without connection configuration (`src/drizzle/migrate.ts:10-12`).

### 3.3 WAL-first durability posture independent of PostgreSQL

- `src/persistence/wal.ts:1-34` — Finn's primary durability mechanism is a write-ahead log with typed, checksummed entries (ULID-identified, SHA-256 checksums), backed by sync/recovery/pruning modules (`src/persistence/`: `r2-sync.ts`, `git-sync.ts`, `recovery.ts`, `pruner.ts`). PostgreSQL is an *additional*, flag-gated store, not the root of Finn's persistence. Boot-order qualification: the flag-gated PostgreSQL block (`src/index.ts:66-84`) runs *before* WAL initialization (`src/index.ts:86-96`), and both the missing-configuration check and boot-time `validateDatabase()` fail-close by stopping boot. On the default (flag-off) path the WAL initializes without any PostgreSQL involvement; in a deployment with the PostgreSQL flag enabled and missing or invalid database configuration, boot stops *before* the WAL initializes. "Independent of PostgreSQL" is therefore a storage-dependency claim, not a boot-sequence claim.

### 3.4 Enforce-not-define runtime boundary surfaces

- `src/hounfour/wire-boundary.ts:58-103` — `parseMicroUSD()` is the wire-ingress parser that canonicalizes and fail-closes malformed monetary values, with explicit DoS bounds. It enforces a format defined elsewhere; it does not define economic semantics. Scope qualification: although the in-source documentation describes it as the sole constructor, internal computation paths also construct `MicroUSD` values directly via type casts (e.g. `src/billing/pricing.ts:89,105,149`; `src/credits/conversion.ts:108,191`) without passing through this parser. The enforce-not-define evidence from this surface is therefore limited to **ingress parsing at the wire boundary**; it is not a repo-wide single-constructor guarantee.
- The broader enforce-not-define inventory (gateway auth/allowlist, hounfour economic-boundary middleware, billing-conservation guard, score-verdict gate, safety firewall/audit chain) was cited in detail, with `file:line` anchors, in the prior evidence artifact [`docs/STRAYLIGHT-ADR-022E-GATE-9-RUNTIME-EVIDENCE-RESULT.md`](STRAYLIGHT-ADR-022E-GATE-9-RUNTIME-EVIDENCE-RESULT.md) §§6–7. That inventory is incorporated here by reference rather than re-verified line-by-line; the spot-checked `wire-boundary.ts` citation above confirms the pattern still holds.

### 3.5 Absence of Straylight coupling in source (negative evidence)

- `git grep -il -e 'straylight' -e 'ADR-022E' -- 'src/**'` returns **no files**. Finn's `src/` tree contains no Straylight or ADR-022E coupling. There is no existing surface that discharges, or could silently drift into, the gate #9 responsibility.

### 3.6 No Railway-specific configuration or runtime binding in source (negative evidence, narrowed)

- Finn's source carries **no Railway-specific configuration, dependency, or runtime binding**: no Railway SDK or API usage, no Railway configuration files (a prior cleanup sprint recorded in task-tracker history deleted `railway.toml` and `deploy/railway.toml` and removed Railway/Fly.io references from docs), and no code path that behaves differently on Railway.
- Narrowing correction: an earlier draft of this claim said Railway references appear in no `src/` files; that was inaccurate. `git grep -in railway -- 'src/**'` returns two **comment-only** mentions in `src/cost/cost-atom.ts` (`:9`, a durability-model comment describing a "single Railway replica" deployment context; `:197`, a comment noting infra rates were verified against the Railway dashboard). These are narrative references to a past deployment context, not configuration or bindings — but they mean the claim Finn can support is "no Railway-specific configuration or runtime binding," not "zero Railway mentions in source."
- Outside the `src/` runtime tree, **active Railway-aware cost tooling exists**: the playtest cost-readout script accepts a `--railway-usage-micro` input and emits a Railway infra-reconciliation line (`scripts/playtest/cop-readout.ts:15,71,279-282`), and the observatory UI/data files carry Railway cost-ledger fields and labels (`observatory/src/lib/data.ts:56,198`; `observatory/src/routes/+page.svelte:135-139`). These are operator-side cost accounting surfaces that treat Railway usage as an externally supplied number; they are not runtime deployment bindings, but they are live code, not historical notes. The negative-evidence claim in this section is therefore strictly scoped to the **`src/` runtime tree**: no Railway-specific configuration, dependency, or runtime binding there. Remaining Railway references beyond these are historical/narrative (CHANGELOG entries, task-tracker history, session notes, Dockerfile comments about a build-context quirk).

## 4. What Finn Cannot Prove Locally

- Any operational property of any managed PostgreSQL provider (durability, backup/restore, failover, version pinning, network isolation, tenancy). These are provider-side facts with no local artifact.
- That Finn's existing `finn`-schema tables or WAL surfaces are suitable, sufficient, or even relevant for a Straylight canonical store. No such requirement exists locally to test against.
- The current state of Straylight gate #8, Finn gate #9, or Dixie gate #10 — gate state lives in `loa-straylight`.
- Anything about `loa-dixie`'s boundary posture.
- End-to-end behavior of the flag-enabled PostgreSQL path against a live provider instance — no such verification artifact exists in-repo, and producing one would exceed this docs-only authorization.

## 5. What Finn Must Defer to Straylight

- Definition of canonical-store semantics and the canonical-store boundary (Straylight is the semantic owner; reaffirmed in the companion packet §3.3).
- Evaluation and any acceptance of Railway PostgreSQL — or any candidate — as a canonical-store substrate.
- Whether and when candidate acceptance authority is requested, and the intake/disposition of this evidence response.

## 6. What Finn Must Defer to Dixie

- All gate #10 boundary evidence and any Dixie-side posture claims. This document makes none.

## 7. What Finn Must Defer to a Later Production Host/Adapter Decision

- Host selection, production database selection, adapter design, migration/cutover approach, connection topology, credential handling, and production wiring. None of these are proposed, sketched, or constrained here; all would require separate authorization in Straylight first.

## 8. Result

**Result token**: `FINN_GATE_9_RUNTIME_BOUNDARY_EVIDENCE_RECORDED`

This record establishes Finn's locally provable runtime/boundary posture and its explicit unknowns and deferrals. It advances no gate by itself.
