# RFC: Agent Memory Runtime + Storage Commitments (Finn Layer 3)

**Status:** Draft only. Do not implement before @deep-name review.
**Slug:** `agent-memory-runtime-storage-commitments`
**Branch:** `draft/rfc-agent-memory-runtime-storage-commitments`
**Date:** 2026-04-27

## Parent and related issues

- Parent (Dixie research/product context): `0xHoneyJar/loa-dixie#89`
- Hounfour protocol question (shared schemas/contracts): `0xHoneyJar/loa-hounfour#57`
- Finn runtime issue (this RFC): `0xHoneyJar/loa-finn#155`

## Scope of this packet

Planning artifacts for the **Finn Layer 3 runtime** side of an agent-memory + chain-agnostic commitment layer. Finn owns runtime execution; it does **not** own:

- Shared protocol schemas — owned by `loa-hounfour` (see `loa-hounfour#57`).
- Product narrative / community surface — owned by `loa-dixie` (parent #89) and `loa-freeside`.
- Workflow / skills / eval changes — owned by `loa-main`.

## Files

| File | Purpose |
|---|---|
| `source-context.md` | Upstream research/context document (input). |
| `research-packet.md` | Finn-scoped synthesis of the source context. |
| `issue-map.md` | Cross-repo ownership and dependency order. |
| `draft-guardrails.md` | What this draft is and is not allowed to touch. |
| `prd.md` | Runtime PRD (problem, behavior, non-goals, acceptance). |
| `sdd.md` | Runtime SDD (architecture, interfaces by name, rollout). |
| `sprint-plan.md` | Sprint plan starting at Sprint 0 (boundary review). |
| `pr-body.md` | Draft PR body + @deep-name review checklist. |

## Implementation gate

Implementation MUST NOT start until:

1. @deep-name reviews this draft PR.
2. `loa-hounfour#57` resolves the shared-schema question (or explicitly defers to consumer-local types).
3. Cross-repo ownership in `issue-map.md` is confirmed.

All artifacts in this directory are **draft pending @deep-name review.**
