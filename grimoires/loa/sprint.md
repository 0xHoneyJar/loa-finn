# Sprint Plan: Bridge Iter-2 Substrate Hardening (PR #157 fixes)

**Cycle:** bridge-iter2-fix
**Source:** Bridgebuilder review of PR #157 (cycle-032 substrate-runtime), iter-1, 2026-05-04
**Review ID:** bridgebuilder-20260504T174805-424a
**PRD/SDD:** `grimoires/loa/prd-cycle-032-substrate-runtime.md` + `grimoires/loa/sdd-cycle-032-substrate-runtime.md` (substrate-runtime context)
**Findings file:** `.run/bridge-reviews/bridge-20260504-1748-r1-iter1-findings.json`

## Scope

Address the 1 HIGH and 5 MEDIUM findings from bridgebuilder iter-1. LOW findings deferred to future iterations. PRAISE findings are validation, no action.

This is a bridge-fix sprint, not a feature sprint — the goal is to harden the substrate-runtime that's already been built and tested in cycle-032.

## Sprint 1: Substrate-Runtime Iter-1 Hardening

**Goal:** Address all HIGH+MEDIUM findings from bridgebuilder iter-1 review on PR #157.

### Task 1.1: Verify or fix ALS context propagation through cached Layers (F1, HIGH)

**File:** `src/substrate/worker-runtime.ts` + new test in `src/substrate/__tests__/`

**Finding:** Bridge proxy Layers (buildBridgeModelRunnerLayer / buildBridgeEventWriterLayer) call `invocationContext.getStore()` to read topLevelJobId. AsyncLocalStorage propagation through `Effect.tryPromise` + `new Promise(...)` + `port.postMessage(...)` callbacks only works inside the same async chain as `invocationContext.run(...)`. Layers are CACHED in runtimeCache and reused across invokes — second+ invokes may read stale snapshot or null.

**Acceptance criteria:**
- [ ] New test `als-context-cached-runtime.test.ts` (or similar): two sequential `handleSubstrateInvoke` calls with DIFFERENT `topLevelJobId` values use the SAME cached runtime, then assert that the ModelRunner bridge proxy received the second call's distinct `topLevelJobId` (not the first's, not null).
- [ ] If the test passes as-is: add a brief comment in `worker-runtime.ts` near the cached Layer construction explaining the ALS-frame invariant relied on.
- [ ] If the test fails: refactor topLevelJobId threading from ALS to either Effect.FiberRef or explicit Context.with(), keeping the bridge proxy contract identical.

### Task 1.2: Protect against dispose-vs-invoke race in handleDisposeRuntime (F17, MEDIUM)

**File:** `src/substrate/worker-runtime.ts`

**Finding:** If `handleSubstrateInvoke` is in flight using `runtimeCache.get(slug)` and concurrently `handleDisposeRuntime(slug)` is called, the runtime is awaited-disposed while still in use. Microtask gap between cache lookup and runtime.runPromiseExit can land dispose between them.

**Acceptance criteria:**
- [ ] Add a per-slug in-flight invoke counter (Map<string, number>).
- [ ] `handleSubstrateInvoke` increments before runPromiseExit and decrements (in finally) after.
- [ ] `handleDisposeRuntime` checks the counter — if > 0, either:
  - Reject with a typed error `RuntimeBusyError` (preferred — caller decides retry)
  - OR queue dispose until counter reaches 0
- [ ] Add unit test that schedules invoke + dispose concurrently and asserts dispose either completes after invoke OR is rejected (no silent disposal of in-flight runtime).

### Task 1.3: Eliminate JWT verify-vs-decode parse differential (F10, MEDIUM)

**File:** `src/substrate/jwt-validator.ts`

**Finding:** After `compactVerify(token, publicKey)` succeeds, the code splits `token.split('.')` and base64-decodes parts[1] manually to extract payload. Verifying one representation and acting on a separately-parsed representation is a parse-differential attack surface (OWASP JWT cheat sheet).

**Acceptance criteria:**
- [ ] Use the `payload` returned by `compactVerify` directly instead of manual decode. (`compactVerify` returns `{ payload: Uint8Array, protectedHeader }` — JSON.parse the payload bytes once, no second decode.)
- [ ] Verify all existing JWT tests pass without modification (correctness invariant).
- [ ] Remove the manual `.split('.')` + base64-decode block.

### Task 1.4: Add trustedPacksDir prefix-edge-case unit test (F4, MEDIUM)

**File:** `src/substrate/__tests__/worker-runtime-trust.test.ts` (new) or add to existing trust test file

**Finding:** The trailing-separator-guard pattern is correctly applied (`registerTrustedPacksDir` appends `sep`). But there's no explicit test that proves `/trusted/packs-evil/foo.js` is REJECTED when only `/trusted/packs` is registered.

**Acceptance criteria:**
- [ ] New unit test: register `/trusted/packs` as trusted, then assert `isModPathTrusted('/trusted/packs-evil/foo.js')` returns false.
- [ ] Companion test: assert `isModPathTrusted('/trusted/packs/foo.js')` returns true.
- [ ] Companion test: assert `isModPathTrusted('/trusted/packs')` (the dir itself, no trailing slash) returns false (not a file).

### Task 1.5: Add tsc --noEmit precondition to e2e test (F5, MEDIUM)

**File:** `src/substrate/__tests__/e2e.integration.test.ts`

**Finding:** beforeAll() catches tsc failures and only verifies worker-entry.js exists, then proceeds. With `--noEmitOnError false`, tsc emits despite type errors, so e2e runs against potentially-broken JS.

**Acceptance criteria:**
- [ ] In beforeAll(), add a `tsc --noEmit --project <substrate-tsconfig>` invocation BEFORE the emit-only invocation.
- [ ] If `tsc --noEmit` exits non-zero, throw an explicit error (don't fall back, don't proceed to file-existence check).
- [ ] If `tsc --noEmit` passes, proceed with the existing emit-only invocation.
- [ ] Add a brief comment explaining why the two-step pattern (check-then-emit) is the correct shape.

### Task 1.6: Document JWT cached status field semantics (F9, MEDIUM)

**File:** `src/substrate/jwt-validator.ts` (the cache hit branch)

**Finding:** On cache hit, code spreads cached.result.license into a new object with overridden status: `{ ...cached.result.license, status: recheck.status }`. The cached entry itself remains with the ORIGINAL status. Any caller that peeks directly into the cache could see stale status.

**Acceptance criteria:**
- [ ] Add a comment near the cache hit branch explaining: "cache.result.status is informational-as-of-cache-write; callers must use the recheck-derived status returned from this function, never reach into cache.result directly."
- [ ] No code change required — this is documentation-only.

## Definition of Done

- [ ] All 6 tasks in Sprint 1 complete with their acceptance criteria met.
- [ ] All existing substrate tests still pass (regression check).
- [ ] New tests added by tasks 1.1, 1.2, 1.4 pass.
- [ ] Code committed with messages referencing the finding ID (`fix(F1): ...`, `fix(F17): ...`, etc.) for traceability back to bridge iter-1.
- [ ] No changes outside `src/substrate/` and its `__tests__/` directory.

## Notes for Implementer

- This is hardening on an already-shipped feature. Prefer minimal, surgical changes over refactors. Don't rewrite what isn't broken.
- If Task 1.1 reveals that ALS context IS broken (test fails), implement the FiberRef refactor in the same task — don't punt.
- Keep an eye on the existing test `sandbox-bridge.test.ts` — it asserts back-compat for omitted topLevelJobId, which must remain green.
- The dispose-vs-invoke counter (Task 1.2) is a performance-neutral safety addition. Don't over-engineer with reactive primitives.
