# Sprint 50: Loa Update & Bridgebuilder Migration

> **Cycle**: cycle-019
> **Global ID**: 50
> **Type**: Migration sprint (focused)
> **Branch**: `chore/loa-update-v1.35.0`

## Context

loa-finn is at Loa framework v1.33.1; upstream is at v1.35.0. The bridgebuilder-review skill received major V3 enhancements (incremental review, persona packs, Loa-aware truncation, streaming API, adaptive retry). loa-finn's custom R2 integration code needs adaptation for 2 new port methods.

## Task Ordering

```
T1 (update-loa) → T3, T4, T5 (adapt finn code) → T6 (entry.ts wiring) → T2 (rebuild dist/) → T7 (tests)
```

T2 (skill rebuild) is intentionally deferred until AFTER finn integration code is adapted, to prevent "compiles but fails at runtime" issues.

## Tasks

### T1: Run `/update-loa` (v1.33.1 → v1.35.0) :white_check_mark:
- Fetch and merge upstream Loa framework files
- Resolve any conflicts in `.claude/` managed files
- Verify `.claude/skills/bridgebuilder-review/` updated with V3 code
- **AC**: `CLAUDE.loa.md` shows v1.35.0, skill source files contain V3 code

### T3: Adapt R2ContextStore — implement new IContextStore methods :white_check_mark:
- Add `getLastReviewedSha(owner, repo, prNumber)` to `R2ContextStore`
- Add `setLastReviewedSha(owner, repo, prNumber, sha)` to `R2ContextStore`
- Store SHA alongside existing hash data in R2 context.json
- **Backward compatibility**: `getLastReviewedSha` returns `null` when field absent in legacy context.json (pre-v1.35.0 persisted state has no SHA data). Note: `null` is correct per upstream `IContextStore` contract (`Promise<string | null>`), confirmed by upstream tests and NoOpContextStore implementation.
- **Non-clobbering writes**: `setLastReviewedSha` writes SHA without overwriting other context fields
- **Legacy fixture test**: include a fixture representing pre-v1.35.0 context.json and verify upgrade-in-place (no throw, graceful null return)
- **AC**: R2ContextStore implements full IContextStore interface (7 methods), TypeScript compiles, legacy context fixture test passes

### T4: Update upstream.ts re-exports :white_check_mark:
- Add new types: `LoaDetectionResult`, `SecurityPatternEntry`, `TokenBudget`, `ProgressiveTruncationResult`, `TokenEstimateBreakdown`
- Add new git-provider types: `GitProviderError`, `GitProviderErrorCode`, `CommitCompareResult`
- Add new config types if any changed signatures
- **Completeness verification**: `npm run typecheck` with all finn imports coming through `upstream.ts` (no deep `#upstream-bridgebuilder/` imports outside the barrel)
- **AC**: All upstream types available to finn consumers, `npm run typecheck` passes

### T5: Adapt config.ts for renamed fields :white_check_mark:
- `personaPath` → `repoOverridePath` in BridgebuilderConfig
- Handle new optional fields: `persona`, `personaFilePath`, `loaAware`, `forceFullReview`, `targetPr`
- **Audit all usage sites**: grep for `personaPath` across entire repo (src/, tests/, docs/) and update all references
- Verify `repoOverridePath` override is actually applied at runtime (entry.ts reads it, persona loads from it)
- **AC**: `loadFinnConfig()` returns valid upstream BridgebuilderConfig, zero `personaPath` references remain in codebase

### T6: Update entry.ts for V3 compatibility :white_check_mark:
- Verify ReviewPipeline constructor signature still matches
- Adopt 5-level persona loading from upstream `loadPersona()` or keep current approach
- Ensure persona model override flows through correctly
- **Do NOT commit dist/ until this task passes**
- **AC**: `npm run bridgebuilder:dry-run` executes without errors

### T2: Rebuild bridgebuilder skill dist/ :white_check_mark:
- Run `npm run build` in `.claude/skills/bridgebuilder-review/`
- Verify compiled JS in `dist/` reflects new source
- Only execute AFTER T3/T4/T5/T6 are complete and dry-run passes
- **AC**: `dist/` contains compiled V3 code, `npm run bridgebuilder:dry-run` still passes after rebuild

### T7: Tests & verification :white_check_mark:
- Run existing bridgebuilder tests: `npm run test:bridgebuilder`
- Add test cases for new R2ContextStore methods:
  - `getLastReviewedSha` returns `null` for unknown PR
  - `setLastReviewedSha` persists and retrieves correctly
  - Legacy context.json without SHA fields loads without error
  - Two-run incremental simulation: first run sets SHA via `setLastReviewedSha`, second run reads it via `getLastReviewedSha` and returns the stored value
- Grep audit: zero remaining references to `personaPath` (excluding docs/changelogs)
- Run full typecheck: `npm run typecheck`
- **AC**: All tests pass, TypeScript compiles clean, no stale field references

## Acceptance Criteria (Sprint Level)

1. Loa framework at v1.35.0
2. Bridgebuilder skill compiled with V3 code
3. R2ContextStore implements full IContextStore interface (7 methods)
4. Legacy R2 context backward compatible (no-throw on missing SHA fields)
5. All existing tests pass + new SHA method tests
6. TypeScript compiles clean
7. `npm run bridgebuilder:dry-run` succeeds
8. Zero stale `personaPath` references in codebase

## Out of Scope

- Adopting Run Bridge feature (v1.35.0) — separate cycle
- Upstream cycle-006 enrichment features (not merged to main)
- Railway deployment changes
- New persona customization
