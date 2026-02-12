# Sprint Plan: loa-hounfour Extraction & Publishing

**Cycle**: cycle-018 (sub-sprint of Sprint 1)
**PRD**: `grimoires/loa/prd-hounfour-phase5-integration.md` — Thread 1 (Protocol Package)
**SDD**: `grimoires/loa/sdd-hounfour-phase5-integration.md` — Section 3 (loa-hounfour design)

## Overview

| Property | Value |
|----------|-------|
| Total sprints | 1 |
| Total tasks | 6 |
| Global sprint ID | 47 |
| Developer | Solo (AI-assisted) |
| Target repo | [0xHoneyJar/loa-hounfour](https://github.com/0xHoneyJar/loa-hounfour) (public, empty) |
| Source | `packages/loa-hounfour/` in loa-finn monorepo |
| Auth | @janitooor via SSH (verified) |

## Context

The `@0xhoneyjar/loa-hounfour` package is **already fully built** inside `packages/loa-hounfour/`:

- 8 source files across `src/schemas/`, `src/vocabulary/`, `src/integrity/`, `src/validators/`
- 6 JSON Schema 2020-12 files in `schemas/`
- 90 tests passing (56 budget vectors, 14 req-hash vectors, 6 idempotency vectors, 14 JWT vectors)
- 5 golden vector scenario files in `vectors/budget/`
- Build output in `dist/` (declarations, source maps, declaration maps)
- Scripts: `schema:generate`, `schema:check`, `semver:check`
- Dependencies: `@sinclair/typebox ^0.34.48`, `jose ^6.1.3`

This is an **extraction and publishing** sprint, not a development sprint. All code is written and tested.

## Dependency Graph

```
Task 1 (Push to repo)
├── Task 2 (Add CI)          [after push]
├── Task 3 (Add README)      [parallel with CI]
└── Task 4 (Publish/dist)    [after CI green]
         │
    Task 5 (Update loa-finn) [after publish]
         │
    Task 6 (Document arrakis consumption) [after loa-finn updated]
```

---

## Sprint 1: Extract, Publish & Wire (Global ID: 47)

**Goal**: Push loa-hounfour to its own repo with CI, make it importable from npm/git, and update loa-finn to consume it externally instead of via `file:` path.

**Exit criteria**: `0xHoneyJar/loa-hounfour` has CI passing (build + test + schema:check). loa-finn's `package.json` points to npm or git dependency (not `file:`). All 144 loa-finn tests still pass. arrakis consumption path documented.

### Tasks

#### Task 1.1: Push package contents to 0xHoneyJar/loa-hounfour
**Description**: Initialize the repo with the contents of `packages/loa-hounfour/`. Set up proper `.gitignore`, push as initial commit on `main`.
**Acceptance Criteria**:
- [ ] `.gitignore` added (ignores `node_modules/`, `dist/`, `.turbo/`, `*.tsbuildinfo`)
- [ ] All source files pushed: `src/`, `schemas/`, `vectors/`, `scripts/`, `tests/`
- [ ] Config files pushed: `package.json`, `tsconfig.json`, `vitest.config.ts`
- [ ] `pnpm-lock.yaml` included for reproducible installs
- [ ] `dist/` NOT committed (built in CI)
- [ ] `node_modules/` NOT committed
- [ ] Initial commit on `main` branch
- [ ] Repo description set: "Shared protocol contracts for the loa-finn ↔ arrakis integration layer"
**Estimated effort**: Small
**Dependencies**: None

#### Task 1.2: Add GitHub Actions CI workflow
**Description**: Create `.github/workflows/ci.yml` with build, test, typecheck, schema validation, and semver check jobs. Matrix across Node 22 (engine requirement).
**Acceptance Criteria**:
- [ ] `.github/workflows/ci.yml` triggers on push to `main` and PRs
- [ ] Jobs: `build` (`tsc`), `test` (`vitest run`), `typecheck` (`tsc --noEmit`), `schema-check` (`tsx scripts/check-schemas.ts`), `semver-check` (`tsx scripts/semver-check.ts`)
- [ ] Uses `pnpm` for package management (matches loa-finn ecosystem)
- [ ] Node 22 (matches `engines.node: ">=22"` in package.json)
- [ ] CI passes on first run (all 90 tests green)
- [ ] Branch protection: require CI pass before merge to `main`
**Estimated effort**: Small
**Dependencies**: Task 1.1

#### Task 1.3: Add README with ownership and versioning policy
**Description**: Create README.md documenting the package purpose, ownership model, versioning policy, and usage instructions.
**Acceptance Criteria**:
- [ ] Package purpose and scope described
- [ ] Installation instructions (npm + git dependency)
- [ ] API overview (schemas, validators, vocabulary, integrity functions)
- [ ] Ownership model: loa-finn team maintains; server owns the contract
- [ ] Versioning policy: semver, N/N-1 support window, breaking change process
- [ ] Exported types listed
- [ ] Link to RFC #31 and Issue #60
**Estimated effort**: Small
**Dependencies**: Task 1.1

#### Task 1.4: Publish package (npm or git dependency)
**Description**: Make the package importable by external consumers. Prefer npm publish to `@0xhoneyjar/loa-hounfour`; fall back to git dependency if npm org credentials aren't configured.
**Acceptance Criteria**:
- [ ] **Option A (preferred)**: Published to npm as `@0xhoneyjar/loa-hounfour@1.0.0`
  - [ ] `npm publish` succeeds with `--access public`
  - [ ] `prepublishOnly` script runs `tsc` to build before publish
  - [ ] `.npmignore` or `files` field limits published contents to `dist/`, `schemas/`, `vectors/`
- [ ] **Option B (fallback)**: Git dependency via `"@0xhoneyjar/loa-hounfour": "github:0xHoneyJar/loa-hounfour"`
  - [ ] `prepare` script runs `tsc` on install so consumers get built output
  - [ ] Verified: `pnpm add github:0xHoneyJar/loa-hounfour` resolves and builds
- [ ] Package importable: `import { JwtClaimsSchema, PoolId, CONTRACT_VERSION } from '@0xhoneyjar/loa-hounfour'`
**Estimated effort**: Small
**Dependencies**: Tasks 1.2 (CI green), 1.3 (README exists)

#### Task 1.5: Update loa-finn to consume from npm/git
**Description**: Replace `"file:./packages/loa-hounfour"` in loa-finn's `package.json` with the npm or git dependency. Verify all imports resolve and tests pass.
**Acceptance Criteria**:
- [ ] loa-finn `package.json` updated: `"@0xhoneyjar/loa-hounfour": "^1.0.0"` (npm) or `"github:0xHoneyJar/loa-hounfour"` (git)
- [ ] `pnpm install` resolves the external dependency
- [ ] All existing imports in `src/hounfour/` resolve correctly:
  - `pool-registry.ts` — `Tier`, `PoolId`, `isValidPoolId`
  - `nft-routing-config.ts` — `PoolId`, `Tier`, `isValidPoolId`
  - `tier-bridge.ts` — types and validators
  - `jwt-auth.ts` — `JTI_POLICY`
- [ ] All 144 loa-finn tests pass (0 regressions)
- [ ] `packages/loa-hounfour/` directory removed from loa-finn (or retained as submodule reference)
- [ ] loa-finn CI still passes
**Estimated effort**: Small
**Dependencies**: Task 1.4

#### Task 1.6: Document arrakis consumption path
**Description**: Add a section to the loa-hounfour README and create an issue in arrakis documenting how to adopt the shared package. Arrakis should replace `tests/e2e/contracts/schema/` with imports from the shared package.
**Acceptance Criteria**:
- [ ] README section: "Consuming from arrakis" with installation + import examples
- [ ] Migration guide: which arrakis fixture files map to which loa-hounfour exports
- [ ] Issue created in `0xHoneyJar/arrakis` referencing loa-hounfour adoption
- [ ] Example: `import { JwtClaimsSchema, InvokeResponseSchema } from '@0xhoneyjar/loa-hounfour'`
**Estimated effort**: Small
**Dependencies**: Task 1.4

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| npm org `@0xhoneyjar` not configured | Can't publish to npm | Fall back to git dependency (Task 1.4 Option B) |
| `dist/` not in repo + git dep needs build step | Install fails for git dep consumers | Add `prepare` script that runs `tsc` |
| loa-finn imports break after switching to external dep | Tests fail | Verify import paths match exactly before removing `packages/` dir |
| `pnpm-lock.yaml` diverges between repos | Dependency resolution differs | Pin exact versions in package.json for critical deps |

## Sprint Summary

| Sprint | Global ID | Tasks | Focus | Key Deliverables |
|--------|-----------|-------|-------|-----------------|
| Sprint 1 | 47 | 6 | Extract & Publish | loa-hounfour repo with CI, npm/git package, loa-finn wired to external dep, arrakis adoption documented |

## Post-Sprint

After this sprint completes:
- Resume cycle-018 Sprint 1 remaining tasks (1.9-1.15: cheval imports, authority boundary, abort fix, LRU)
- Or proceed to Sprint 2 (Integration Hardening) if cheval tasks are deferred
- arrakis team can adopt loa-hounfour at their own velocity
