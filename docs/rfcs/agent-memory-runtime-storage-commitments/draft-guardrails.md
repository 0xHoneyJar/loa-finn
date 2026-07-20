# Draft Guardrails — Finn Agent Memory Runtime + Storage Commitments

**Status:** Draft only. Do not implement before @deep-name review.

## Allowed during this draft

- Read existing Finn architecture, modules, persistence layer, safety layer, budget/billing path, tests.
- Read `docs/`, `grimoires/loa/`, and existing RFCs for grounding.
- Read parent issues in `loa-dixie#89` and `loa-hounfour#57` for cross-repo alignment.
- Generate planning artifacts under:
  - `docs/rfcs/agent-memory-runtime-storage-commitments/` (this directory)
- Open a **draft** PR for these planning artifacts.

## Forbidden until @deep-name review

- Any change under `src/` (no implementation, no stubs, no scaffolding).
- Any change under `drizzle/` or other migration directories.
- Any change under `schemas/` (canonical wire-format schemas live in `loa-hounfour`; tracked in `loa-hounfour#57`).
- Any change under `deploy/` or `infrastructure/`.
- Any change to `package.json`, `package-lock.json`, `pnpm-lock.yaml`, or any lockfile.
- Any change under `.claude/` (System Zone — Loa-managed).
- Any change to `Dockerfile`, `docker-compose*.yaml`, or container/CI configs.
- Enabling any new production behavior (no flags flipped, no env defaults changed).
- Running `/run`, `/run-bridge`, `/ship`, `/deploy-production`, or any deploy command.
- Running migrations or DB generation (`db:generate`, `db:migrate`).
- Running Bridgebuilder against this branch (`bridgebuilder`, `bridgebuilder:dry-run`).

## Hounfour boundary (hard rule)

This RFC **must not** define wire-format schemas locally. Any apparent need to define a `MemoryArtifact`, `MemoryCommitment`, `AgentIdentity`, `AccessPolicy`, `ReputationEvent`, `ValidationRecord`, or `StoragePointer` type — or any field on those — is a signal to:

1. Stop.
2. Check `loa-hounfour#57` for the current state.
3. If absent, leave a question in `research-packet.md` § 10 for @deep-name and continue with the **interface name only**, not the field shape.

## Finn boundary (Layer 3 only)

This RFC must not:

- Add product API/UX (belongs in `loa-freeside` and/or `loa-dixie`).
- Add Oracle/knowledge product semantics (belongs in `loa-dixie`).
- Add slash commands, skills, eval harness changes, or run-mode changes (belongs in `loa-main`).

If a proposal seems to require any of the above, capture it in `issue-map.md` and `research-packet.md` § 10 — do not stage it in this repo.

## Stop-and-ask conditions

Stop and request review immediately if any of these occur during the draft pass:

- A planning step seems to require editing `.claude/`.
- A planning step seems to require defining a schema in this repo.
- A planning step seems to require a migration, deploy change, or lockfile change.
- A planning step seems to require flipping a runtime flag or default.
- The repo ownership boundary becomes unclear between Finn / Hounfour / Freeside / Dixie.
- A new cost surface (chain tx, paid storage, external API) is implied without a budget plan.
