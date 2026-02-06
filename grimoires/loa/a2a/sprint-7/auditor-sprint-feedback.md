# Sprint 7 Security Audit: Persistence Refactoring

> **Sprint**: 7 (Global ID: 7, Cycle: cycle-002)
> **Auditor**: Claude Opus 4.6 (Paranoid Cypherpunk Auditor)
> **Date**: 2026-02-06
> **Branch**: `loa-update-review`
> **Verdict**: **APPROVED - LETS FUCKING GO**

---

## Executive Summary

Sprint 7 replaces Finn's custom persistence layer with the upstream Loa persistence framework. The implementation demonstrates strong security discipline: timing-safe auth, no shell injection vectors, path traversal prevention, recovery timeouts, and integrity checksums. No CRITICAL or HIGH severity findings. Three MEDIUM findings are quality-of-life issues with clear remediation paths.

**Build**: Clean (0 errors, 0 warnings)
**Finn Tests**: 36/36 PASS (`pnpm test:finn`)
**Upstream Tests**: 338/338 PASS (vitest)

---

## Security Checklist

### Secrets Management

| Check | Status | Evidence |
|-------|--------|----------|
| No hardcoded credentials | PASS | All secrets from env vars (`config.ts:51-96`) |
| `.env` in `.gitignore` | PASS | Lines 16-20 in `.gitignore` |
| `.env.example` has no real values | PASS | Placeholder format only |
| Secrets not logged | PASS | `console.log` only outputs model + port (`index.ts:30`) |
| Credentials in config struct | NOTE | `FinnConfig.r2.secretAccessKey` held in memory — acceptable for process lifetime |

### Authentication & Authorization

| Check | Status | Evidence |
|-------|--------|----------|
| Timing-safe token comparison | PASS | `safeCompare()` in `auth.ts:8-11` — SHA-256 + `timingSafeEqual` |
| Bearer token auth on API routes | PASS | `authMiddleware` on `/api/*` (`server.ts:50`) |
| WS auth at upgrade time | PASS | `validateWsToken()` in `index.ts:194` |
| Rate limiting on API | PASS | Token bucket per IP (`rate-limit.ts`) |
| Per-IP WS connection cap | PASS | `MAX_CONNECTIONS_PER_IP = 5` (`ws.ts:24`) |
| Session limit enforced | PASS | `MAX_SESSIONS = 100` (`sessions.ts:23`) |
| Dev mode auth bypass documented | PASS | Auth skipped when `FINN_AUTH_TOKEN` is empty — intentional |

### Input Validation

| Check | Status | Evidence |
|-------|--------|----------|
| WAL path traversal prevention | PASS | `walPath()` rejects `..`, `//`, invalid chars (`wal-path.ts:19-28`) |
| Git ref validation | PASS | `validateRef()` rejects shell metacharacters (`git-sync.ts:13-17`) |
| No shell injection | PASS | All git ops use `execFileSync` (no shell), beads use `execFile` |
| WS payload size limit | PASS | `MAX_PAYLOAD_BYTES = 1MB` (`ws.ts:21`) |
| WS idle timeout | PASS | `IDLE_TIMEOUT_MS = 300_000` (`ws.ts:22`) |
| JSON parse error handling | PASS | All `JSON.parse` calls have catch handlers |
| API input validation | PASS | Empty text rejected (`server.ts:79`, `ws.ts:164`) |

### CORS & Origin Validation

| Check | Status | Evidence |
|-------|--------|----------|
| No origin suffix matching | PASS | Exact match or escaped wildcard regex (`auth.ts:63-83`) |
| Malformed origin rejected | PASS | `new URL(origin)` in try/catch (`auth.ts:66-68`) |
| Credentials header scoped | PASS | Only set when origin is allowed |

### Data Integrity

| Check | Status | Evidence |
|-------|--------|----------|
| SHA-256 on R2 uploads | PASS | `x-amz-meta-sha256` (`r2-storage.ts:80-86`, `r2-sync.ts:96`) |
| R2 restore integrity check | PASS | Download + recompute + compare (`r2-sync.ts:184-188`) |
| WAL entry checksums | PASS | Upstream `computeEntryChecksum` / `verifyEntry` |
| Git divergence detection | PASS | `merge-base` check before push (`git-sync.ts:157-163`) |
| Two-source prune guard | PASS | `min(confirmedR2Seq, confirmedGitSeq)` (`pruner.ts:31,49`) |

### Recovery & Resilience

| Check | Status | Evidence |
|-------|--------|----------|
| Per-source recovery timeout | PASS | `TimeoutSource` wraps all sources — 5s available, 30s restore (`recovery.ts:47-79`) |
| Overall boot deadline | PASS | 120s total (`recovery.ts:50,228-233`) |
| Template fallback on timeout | PASS | Graceful degradation (`recovery.ts:236-249`) |
| Graceful shutdown sequence | PASS | Stop scheduler → stop watcher → final sync → drain WAL → exit (`index.ts:217-249`) |
| Forced shutdown timeout | PASS | 30s hard exit (`index.ts:253-256`) |
| Circuit breaker per task | PASS | 3 failures → OPEN, lazy transitions (`scheduler.ts:45-56`) |

### Code Quality

| Check | Status | Evidence |
|-------|--------|----------|
| TypeScript strict mode | PASS | `"strict": true` in `tsconfig.json` |
| Build passes clean | PASS | `pnpm build` — 0 errors |
| No `any` abuse | PASS | Only 2 uses in `ws.ts` for message parsing — acceptable |
| Scheduler timer cleanup | PASS | `.unref()` on all timers |

---

## Findings

### M1: R2 Endpoint URL Not Validated (MEDIUM)

**Location**: `r2-storage.ts:33`, `r2-sync.ts:54`
**SDD Reference**: SDD §9, deferred in review

The R2 endpoint URL from `process.env.R2_ENDPOINT` is passed directly to the S3Client without pattern validation. An attacker with env access could redirect R2 credentials to a harvesting server.

**Risk**: Credential exfiltration via malicious endpoint — requires env variable access (already game-over in most threat models).
**Remediation**: Add `validateR2Endpoint(url)` that checks against `*.r2.cloudflarestorage.com` or `*.r2.dev` patterns.
**Severity**: MEDIUM — mitigated by the fact that env access implies full compromise already.
**Accepted as deferred**: Yes — tracked in reviewer.md.

### M2: Finn Tests Not Discoverable by Vitest (MEDIUM)

**Location**: All 6 files in `tests/finn/`

Finn tests use a custom `async function test()` + `main()` pattern instead of vitest's `describe()`/`it()` API. Running `npx vitest run` reports 6 "FAIL — No test suite found" errors. Tests pass correctly via `pnpm test:finn` (tsx runner).

**Risk**: CI confusion — `npx vitest` would report failures even though tests pass.
**Remediation**: Either convert to vitest syntax or exclude `tests/finn/` from vitest config and add a unified `pnpm test` script.

### M3: No Unified Test Script (MEDIUM)

**Location**: `package.json`

No `"test"` script in package.json. Tests are split across:
- `pnpm test:finn` — 36 finn tests via tsx
- `npx vitest run` — 338 upstream tests

**Risk**: CI setup confusion, regressions missed if wrong command used.
**Remediation**: Add `"test": "pnpm test:finn && vitest run .claude/lib/persistence/__tests__/"`.

### L1: Health Endpoint Unauthenticated (LOW)

**Location**: `server.ts:34-46`

`/health` exposes WAL state, disk pressure, model name, session count, recovery state, and scheduler status without authentication. Standard practice when behind a reverse proxy, but leaks operational info if exposed publicly.

**Risk**: Information disclosure — operational metadata only, no PII or secrets.
**Remediation**: Consider auth or network-level restriction in production.

### L2: Redundant WS Auth Logic (LOW)

**Location**: `index.ts:194` + `ws.ts:141-155`

WS auth is validated at HTTP upgrade time (index.ts) and again via message-based flow (ws.ts). The message-based auth in ws.ts is effectively dead code when auth is configured, since index.ts rejects unauthenticated upgrades.

**Risk**: None — defense in depth, but the redundancy creates confusion.
**Remediation**: Document the dual-auth or remove message-based auth from ws.ts.

---

## Deferred Items Acknowledged

These were already flagged in the reviewer report and are acceptable deferrals:

| Item | Reason | Tracked |
|------|--------|---------|
| CheckpointProtocol two-phase integration | Current r2-sync works; full rewrite deferred | Future sprint |
| r2-sync.ts deletion | Still primary sync mechanism | Future sprint |
| git-sync.ts rename to git-push.ts | Cosmetic | Future sprint |
| Template fallback → outbound sync disabled | Needs plumbing | Future sprint |
| BeadsRecoveryHandler re-export | Upstream type issue | Issue #14 |

---

## Verdict

**APPROVED - LETS FUCKING GO**

The sprint demonstrates strong security engineering:
- Zero shell injection vectors (all `execFileSync`)
- Timing-safe auth comparison
- Path traversal prevention at the WAL layer
- Per-source and overall recovery timeouts (addressing #15)
- SHA-256 integrity on all R2 operations
- Rate limiting, connection caps, payload limits
- Proper CORS origin validation
- Two-source confirmation before WAL pruning
- Clean build, all tests passing

The three MEDIUM findings are non-blocking: M1 is a known deferral, M2/M3 are test infrastructure improvements that don't affect runtime security. No findings warrant blocking the sprint.

Ship it.
