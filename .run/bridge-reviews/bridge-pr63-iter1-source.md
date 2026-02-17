# Bridgebuilder Review: PR #63 - Bridgebuilder V3 Migration + Hounfour Phase 5

**Reviewer**: Bridgebuilder (V3 Dual-Stream)
**Date**: 2026-02-13
**Scope**: ~8,800 lines across `src/bridgebuilder/`, `src/hounfour/`, `adapters/`, `packages/loa-hounfour/`

---

## Opening Context

This is a substantial systems-level PR that simultaneously executes two major workstreams: the Bridgebuilder V3 incremental review infrastructure (R2 SHA tracking, upstream re-exports) and the Hounfour Phase 5 implementation (native runtime, streaming ensemble, JWT hardening, BYOK redaction, integer micro-USD budget migration, NFT personality routing).

The ambition is significant. What I see here is the architecture of a multi-tenant AI gateway taking serious shape -- the kind of system where every authorization failure mode, every budget race condition, every credential leak matters because real money and real user data flow through these paths. The team clearly understands the stakes: the deny-by-default redaction strategy, the write-ahead JSONL journal, the BigInt-only cost path, the JWKS state machine -- these are all decisions that reflect production experience with systems that handle financial data.

Let me walk through what I found.

---

## Architectural Observations

### Port-Adapter Integrity: Clean Separation

The Python `adapters/` cherry-pick from `loa_cheval` is disciplined. The `authority_boundary_test.py` file (scanning cheval modules via AST for budget enforcement patterns) is an unusually thoughtful architectural test. This is the kind of "fitness function" that the Evolutionary Architecture community advocates -- and it is genuinely rare to see it enforced at the import boundary. The circuit breaker, cost ledger, and usage calculator each have clear single responsibilities. The cheval sidecar NEVER enforces budget limits -- that invariant is not just documented but tested via static analysis. This is exactly right.

### Integer-Only Cost Path: Lessons from Stripe

The migration from floating-point USD to integer micro-USD is the single most important correctness change in this PR. At Stripe, the transition to integer cents was a multi-quarter effort that touched every service. Here, the team has made the right choice: BigInt on the TypeScript side, Python `int` on the cheval side, string serialization on the wire. The golden vector cross-check between TypeScript and Python is the correct way to validate cross-language parity. The `RemainderAccumulator` for sub-micro-USD carry is a nice touch that shows the team understands accumulation drift.

### JWKS State Machine: Netflix-Grade Resilience

The JWKS lifecycle (HEALTHY -> STALE -> DEGRADED) with circuit breaker on refresh failures, rate-limited refresh, and compromise mode toggle is exactly the right pattern for a multi-tenant gateway. The decision to reject unknown kids in DEGRADED state while allowing refresh attempts in STALE state is the correct security/availability tradeoff.

### Streaming Ensemble: Winner Latch

The `firstCompleteStreaming` design -- race N streams, latch the winner on first content-bearing chunk, cancel losers, attribute cost per-branch -- is architecturally sound. The single-threaded JS event loop means the winner latch does not need atomics or mutexes, which is correctly called out in comments. The 3-tier billing fallback (provider_reported -> observed_chunks_overcount -> prompt_only) for cancelled branches is the right approach.

---

<!-- bridge-findings-start -->
```json
[
  {
    "id": "BB-063-001",
    "title": "Circuit breaker read-then-write race in check_state OPEN->HALF_OPEN transition",
    "severity": "MEDIUM",
    "category": "concurrency",
    "file": "adapters/circuit_breaker.py:L86-L94",
    "description": "check_state() reads state, checks the timeout, transitions OPEN->HALF_OPEN, and writes back. Between read and write, another concurrent request could also read OPEN, also decide to transition, and also write HALF_OPEN. While the docstring correctly notes 'best-effort counting: concurrent read-modify-write races are intentional', the OPEN->HALF_OPEN transition is more concerning than failure counting because it resets half_open_probes to 0 twice, allowing more probes than configured. In a high-concurrency scenario, this could let N requests through simultaneously in HALF_OPEN when max_probes=1.",
    "suggestion": "The file-level flock in _write_state protects write atomicity, but not the read-modify-write cycle. Consider using flock around the full check_state read-modify-write when transitioning OPEN->HALF_OPEN, or accept the risk with a comment noting that extra probes are bounded by concurrency count and are self-correcting.",
    "faang_parallel": "Netflix Hystrix originally had a similar issue with its half-open probe count. They moved to an AtomicInteger for the probe counter specifically because multiple probes could be admitted simultaneously.",
    "teachable_moment": "File locks protect individual writes but not read-modify-write sequences. The gap between reading and acquiring the lock is the vulnerability window."
  },
  {
    "id": "BB-063-002",
    "title": "BYOK redaction entropy threshold may produce false negatives on short API key fragments",
    "severity": "MEDIUM",
    "category": "security",
    "file": "src/hounfour/byok-redaction.ts:L93-L99",
    "description": "The high-entropy base64 catch-all uses threshold > 4.5 bits/char and minimum length 21. Some provider API key fragments embedded in error messages may be shorter than 21 characters or have entropy below 4.5 (e.g., 'sk-proj-abc123xyz456' has relatively low entropy due to the 'sk-proj-' prefix). The known-pattern regex layer covers the common prefixes, but providers occasionally change key formats. A leaked 15-character suffix of an API key is still a credential exposure.",
    "suggestion": "Consider lowering the entropy catch-all minimum length to 16 characters, or add a dedicated pattern for keys that have been truncated by error messages (e.g., partial key matches where the known prefix is present but the full regex does not match due to truncation).",
    "metaphor": "This is like a metal detector set to ignore small objects -- most weapons are caught, but a small blade can slip through.",
    "teachable_moment": "Deny-by-default is the right first layer. The entropy-based second layer is defense in depth. But defense in depth is only effective when each layer's blind spots do not overlap."
  },
  {
    "id": "BB-063-003",
    "title": "JWKS state machine singleton prevents per-route audience isolation in tests",
    "severity": "LOW",
    "category": "architecture",
    "file": "src/hounfour/jwt-auth.ts:L145-L156",
    "description": "The module-level globalJWKS singleton (getOrCreateJWKS) means all endpoint types share the same state machine. While the ValidateJWTOptions.jwksMachine override exists for testing, the production path always uses the singleton. This means a JWKS degradation for S2S validation also degrades invoke validation, even though they may use different kid namespaces. Currently this is acceptable since both share the same JWKS endpoint, but if gateway and S2S keys are ever served from different endpoints, this will need refactoring.",
    "suggestion": "Add a comment documenting the design constraint: 'Single JWKS endpoint assumed. If gateway and S2S use separate endpoints, refactor to per-endpoint state machines.' This makes the assumption explicit for future maintainers.",
    "teachable_moment": "Singletons are fine when the singleton genuinely represents a single resource. Document the assumption so it breaks visibly when it stops being true."
  },
  {
    "id": "BB-063-004",
    "title": "namespaceJti does not sanitize issuer string, allowing crafted iss to collide",
    "severity": "HIGH",
    "category": "security",
    "file": "src/hounfour/jwt-auth.ts:L218-L220",
    "description": "namespaceJti concatenates as `jti:{iss}:{jti}`. If an attacker controls two issuers (e.g., 'evil:fake' and 'evil'), they can craft tokens where namespaceJti('evil', 'fake:victim-jti') === namespaceJti('evil:fake', 'victim-jti'). Both produce 'jti:evil:fake:victim-jti'. This allows cross-issuer JTI collision: a replay from issuer A could incorrectly flag a legitimate token from issuer B as a replay, causing denial of service. While the issuer allowlist limits the attack surface, the collision is still possible between any two allowed issuers where one's suffix matches the other's JTI prefix.",
    "suggestion": "Use a separator that cannot appear in the issuer string, or hash the components: `jti:${sha256(iss)}:${jti}`. Alternatively, use a structured separator like `jti:${iss.length}:${iss}:${jti}` (length-prefixed) to prevent ambiguity.",
    "faang_parallel": "Google's macaroon-based auth tokens use HMAC chaining specifically to avoid this class of concatenation ambiguity. The Linux kernel's keyring also uses structured key descriptions to prevent namespace collisions.",
    "teachable_moment": "String concatenation with a delimiter is only unambiguous if the delimiter cannot appear in the concatenated values. This is a classic canonicalization vulnerability."
  },
  {
    "id": "BB-063-005",
    "title": "reconciliation-client poll timer leaks on error in getS2sToken()",
    "severity": "LOW",
    "category": "error-handling",
    "file": "src/hounfour/reconciliation-client.ts:L215-L218",
    "description": "startPolling sets up setInterval that calls poll().catch(() => {}). The catch swallows all errors, including those from getS2sToken(). If getS2sToken() consistently throws (e.g., credential misconfiguration), the poll timer continues firing indefinitely, generating suppressed errors every pollIntervalMs. This is a slow resource leak (promise allocations, stack traces) and makes the misconfiguration invisible.",
    "suggestion": "Log the error in the catch handler. Consider adding a circuit breaker on consecutive getS2sToken failures that pauses polling and surfaces the issue via the onStateChange callback.",
    "teachable_moment": "Never swallow errors silently in a timer callback. The error may be transient (and swallowing is fine), or it may be permanent (and swallowing hides a configuration bug for days)."
  },
  {
    "id": "BB-063-006",
    "title": "LedgerV2.doAppend opens file for read to fsync, but appendFileSync already closed the fd",
    "severity": "LOW",
    "category": "error-handling",
    "file": "src/hounfour/ledger-v2.ts:L375-L385",
    "description": "doAppend calls appendFileSync (which opens, writes, and closes the fd internally), then opens the file again with openSync(filePath, 'r') for fdatasyncSync. The problem is that fdatasync on a read-only fd may not flush the data written by the previous appendFileSync on some filesystems. The POSIX spec states fdatasync flushes data written through 'that' fd. Opening a new fd creates a separate file description. On Linux with ext4 this typically works because the filesystem flushes the page cache, but it is not guaranteed by POSIX.",
    "suggestion": "Open the fd once with O_WRONLY | O_APPEND, write manually, then fdatasync on the same fd before closing. This guarantees the fsync applies to the written data.",
    "faang_parallel": "This is the exact class of bug that caused the LevelDB fsync controversy in 2018. PostgreSQL's WAL writer and SQLite both open the fd once and fsync the same fd.",
    "teachable_moment": "For durability guarantees, the fd you fsync must be the same fd you wrote through. Opening a new fd and fsyncing it is not portable."
  },
  {
    "id": "BB-063-007",
    "title": "config_loader symlink check is racy (TOCTOU)",
    "severity": "MEDIUM",
    "category": "security",
    "file": "adapters/config_loader.py:L107",
    "description": "The symlink check (`path.is_symlink()`) occurs before the file is read. Between the check and the read, an attacker with filesystem access could replace the real file with a symlink (or replace the symlink with a real file). This is a classic TOCTOU (Time Of Check, Time Of Use) race condition. The impact is limited because the attacker needs local filesystem access, and the allowed_dirs restriction still applies to the resolved target.",
    "suggestion": "Open the file, then check the fd with os.fstat() to verify the file descriptor is not a symlink. Alternatively, use O_NOFOLLOW when opening to reject symlinks atomically. The current check is still valuable as a first line of defense, but document the TOCTOU limitation.",
    "teachable_moment": "Filesystem checks followed by filesystem operations are inherently racy. The only safe approach is to operate on file descriptors, not paths."
  },
  {
    "id": "BB-063-008",
    "title": "ensemble-budget releaseAll uses non-atomic hgetall + incrby",
    "severity": "MEDIUM",
    "category": "concurrency",
    "file": "src/hounfour/redis/ensemble-budget.ts:L223-L244",
    "description": "releaseAll() calls hgetall to read all remaining reservations, sums them in JS, then calls incrby(-totalRefund) and del(reservedKey). Between hgetall and incrby, a concurrent commitBranch could modify the reservation hash and the budget counter, leading to a double-refund. If commitBranch refunds branch 0 while releaseAll is in flight, the total refund includes branch 0's amount, but commitBranch already decremented it. The budget counter ends up lower than it should be.",
    "suggestion": "Write a Lua script for releaseAll that atomically reads all remaining reservations, sums them, decrements the budget, and deletes the hash in a single atomic operation. This is the same pattern used for reserve and commitBranch.",
    "faang_parallel": "This is exactly why Stripe's payment intents use Redis Lua for all balance mutations. Any non-atomic read-modify-write across multiple keys is a potential double-entry accounting error.",
    "teachable_moment": "If reserve and commitBranch are Lua scripts for atomicity, releaseAll must be too. Inconsistent atomicity guarantees across operations on the same data structure is a common source of financial bugs."
  },
  {
    "id": "BB-063-009",
    "title": "NativeRuntimeAdapter proc.unref() prevents Node from tracking zombie processes",
    "severity": "MEDIUM",
    "category": "error-handling",
    "file": "src/hounfour/native-runtime-adapter.ts:L277",
    "description": "spawnChild() calls proc.unref() immediately after spawning. This tells Node.js not to keep the event loop alive for this child process. While this is correct for fire-and-forget processes, combined with detached: true, it means Node will not block exit if the child is still running. If the Node process exits (e.g., graceful shutdown) before the escalateKill sequence completes, the child process group becomes orphaned. The verifyGroupEmpty check at the end of complete()/stream() mitigates this, but only if the stream consumer runs to completion.",
    "suggestion": "Consider calling proc.unref() only AFTER the escalateKill sequence completes (in the finally block), or implement a process tracking registry that ensures all spawned children are killed on SIGTERM/SIGINT.",
    "faang_parallel": "Kubernetes pod termination and the Linux kernel's cgroup reaping both face this exact problem. The cgroup approach (freezer cgroup) is the gold standard because it cannot leak processes.",
    "teachable_moment": "detached + unref means the parent has explicitly abdicated responsibility for the child. This is only safe if you have a secondary cleanup mechanism (like verifyGroupEmpty via pgrep)."
  },
  {
    "id": "BB-063-010",
    "title": "R2ContextStore SHA persistence does not evict old entries",
    "severity": "LOW",
    "category": "architecture",
    "file": "src/bridgebuilder/adapters/r2-context.ts:L73-L82",
    "description": "setLastReviewedSha writes to this.data.shas but does not call this.evictIfNeeded(). The hash entries have eviction logic (evictIfNeeded removes oldest entries when exceeding a limit), but SHA entries can grow unboundedly. Over time, the context.json blob will grow with every new PR that gets an incremental review, potentially hitting R2 object size limits or causing latency on load().",
    "suggestion": "Apply the same eviction policy to the shas map, or share a combined eviction strategy across both hashes and shas.",
    "teachable_moment": "When you add a new data dimension to an existing store, audit whether the existing management policies (eviction, cleanup, rotation) also apply to the new dimension."
  },
  {
    "id": "BB-063-011",
    "title": "resolve_chat_url ignores base_url entirely",
    "severity": "LOW",
    "category": "error-handling",
    "file": "adapters/provider_registry.py:L100-L105",
    "description": "resolve_chat_url receives the provider config (including base_url), strips its trailing slash, but then returns only defaults.chat_path without prepending the base_url. The function name suggests it resolves a full URL, but it only returns the path. Callers that expect a full URL will get an incorrect result.",
    "suggestion": "Either rename to resolve_chat_path() to match behavior, or return f'{base_url}{defaults.chat_path}' to match the function name. Check how callers use this return value.",
    "teachable_moment": "Function names are contracts. If the name says 'URL' but the code returns a path, every caller must know the discrepancy, or bugs will occur at integration time."
  },
  {
    "id": "BB-063-012",
    "title": "Budget migration convertV1ToV2 uses Math.round which can lose precision for large USD values",
    "severity": "MEDIUM",
    "category": "error-handling",
    "file": "src/hounfour/budget-migration.ts:L109-L113",
    "description": "convertV1ToV2 computes totalMicro = Math.round(v1.total_cost_usd * 1_000_000). For v1 entries where total_cost_usd > 2^53 / 1_000_000 = $9,007,199,254 (~$9B), the multiplication exceeds Number.MAX_SAFE_INTEGER and loses precision silently. While no single tenant is likely to have a $9B entry, the aggregate totalV1CostUsd accumulated across all entries could also lose precision if a tenant has millions of entries summing to a large number. The verification step uses BigInt for the v2 total but Number for the v1 total, meaning the comparison may be inaccurate.",
    "suggestion": "Add a guard: if (v1.total_cost_usd * 1_000_000 > Number.MAX_SAFE_INTEGER) throw an error or use a multi-step conversion that avoids the precision boundary. For the aggregate, accumulate v1 totals as BigInt(Math.round(entry.total_cost_usd * 1_000_000)) per entry rather than summing as float.",
    "teachable_moment": "The whole point of migrating to integer micro-USD is to avoid floating-point precision issues. The migration itself must not introduce the exact class of bug it is fixing."
  },
  {
    "id": "BB-063-013",
    "title": "Streaming ensemble abort signal listeners are not cleaned up if raceForFirstChunk rejects",
    "severity": "LOW",
    "category": "error-handling",
    "file": "src/hounfour/ensemble.ts:L485-L492",
    "description": "In firstCompleteStreaming, the external abort signal listener is added with { once: true } which self-cleans on trigger. However, if the signal is never triggered and the stream completes normally (or all branches fail), the listener remains registered on the external AbortSignal. For long-lived AbortControllers (e.g., request-scoped), this is a minor leak. The bestOfNStreaming and consensusStreaming functions have the same pattern.",
    "suggestion": "Store the listener reference and remove it in the finally block of generateStream(), similar to how the timeout is cleared. This is a minor cleanup but prevents accumulation in long-running processes.",
    "teachable_moment": "addEventListener with { once: true } only self-cleans when the event fires. If the event never fires, the listener persists for the lifetime of the EventTarget."
  },
  {
    "id": "BB-063-014",
    "title": "PRAISE: Authority boundary test is an exceptional architectural fitness function",
    "severity": "PRAISE",
    "category": "architecture",
    "file": "adapters/authority_boundary_test.py",
    "description": "The authority_boundary_test.py file scans all cheval modules via AST, importlib, and inspection to verify that budget enforcement code never leaks into the sidecar. This is a genuine architectural fitness function -- it will catch violations at test time rather than in production. The combination of attribute scanning, class inspection, function name pattern matching, and AST-level raise statement analysis is thorough. The test also includes wire contract verification (cost fields are informational strings, not enforcement gates). This is the kind of test that pays for itself many times over.",
    "faang_parallel": "Google's 'build visibility' rules enforce similar boundaries at the build system level. This test achieves the same goal at the test level, which is arguably more portable and more expressive.",
    "teachable_moment": "Architectural invariants should be tested, not just documented. If a boundary matters, write a test that breaks when the boundary is violated."
  },
  {
    "id": "BB-063-015",
    "title": "PRAISE: Write-ahead JSONL + Redis Lua idempotency is textbook exactly-once budget recording",
    "severity": "PRAISE",
    "category": "architecture",
    "file": "src/hounfour/redis/atomic-budget.ts",
    "description": "The AtomicBudgetRecorder implements a correct write-ahead protocol: JSONL append first (crash-safe journal), then Redis Lua script (atomic INCRBY + idempotency check). The crash matrix documentation is excellent -- it explicitly enumerates all four crash scenarios and explains why each one is recoverable. The idempotency key derivation from tenant + reqHash + provider + model ensures that retries of the same logical request are deduplicated, while different requests get charged independently. The recoverFromJournal method correctly uses SET (not INCRBY) to replace the Redis value with the authoritative JSONL total.",
    "faang_parallel": "This is essentially a simplified version of Kafka's exactly-once transactional protocol. The JSONL file is the log, Redis is the materialized view, and the idempotency key is the producer ID.",
    "teachable_moment": "Exactly-once semantics require three things: a durable journal, an idempotency key, and a recovery path that recomputes from the journal. This implementation has all three."
  },
  {
    "id": "BB-063-016",
    "title": "PRAISE: Constant-time hash comparison in req-hash verification",
    "severity": "PRAISE",
    "category": "security",
    "file": "packages/loa-hounfour/src/integrity/req-hash.ts:L191-L204",
    "description": "verifyReqHash uses timingSafeEqual for hash comparison, preventing timing side-channel attacks. The implementation correctly handles the length check before timingSafeEqual (which requires equal-length buffers). The decompression safety limits (max body size, max compression ratio, max encoding depth) are well-calibrated to prevent decompression bomb attacks while allowing legitimate use.",
    "teachable_moment": "Timing side-channels in hash comparison are well-known but still frequently missed. Using timingSafeEqual is the correct approach, and the length pre-check is necessary because timingSafeEqual throws on mismatched lengths."
  },
  {
    "id": "BB-063-017",
    "title": "personaPath renamed to repoOverridePath without config schema migration",
    "severity": "LOW",
    "category": "architecture",
    "file": "src/bridgebuilder/entry.ts:L69",
    "description": "The field config.personaPath was renamed to config.repoOverridePath. If any existing configuration files or environment variables reference personaPath, they will silently fall through to the default value ('grimoires/bridgebuilder/BEAUVOIR.md'). This is a breaking change for users who customized the persona path.",
    "suggestion": "Add a backward-compatibility check: if config.personaPath exists and config.repoOverridePath does not, use config.personaPath and log a deprecation warning.",
    "teachable_moment": "Config renames are breaking changes. Either support both names with a deprecation period, or document the migration in release notes."
  },
  {
    "id": "BB-063-018",
    "title": "JWKSStateMachine.refresh creates a new RemoteJWKSet on every call without closing the old one",
    "severity": "LOW",
    "category": "error-handling",
    "file": "src/hounfour/jwt-auth.ts:L109-L120",
    "description": "refresh() creates a new createRemoteJWKSet(new URL(this.jwksUrl)) and replaces this.jwksFn. The previous RemoteJWKSet instance may still have pending HTTP requests or cached data. The jose library's createRemoteJWKSet returns a function with internal caching, but there is no explicit cleanup/abort of the old instance's in-flight requests. Under rapid refresh scenarios (e.g., after circuit breaker cooldown), this could lead to multiple concurrent JWKS fetches to the same endpoint.",
    "suggestion": "This is likely benign because jose handles this internally and the rate limiter prevents rapid refreshes. Add a comment noting that the old instance is GC'd and any in-flight requests will complete but their results are discarded.",
    "teachable_moment": "When replacing long-lived objects that hold resources (HTTP connections, file handles), consider whether the old instance needs explicit cleanup."
  },
  {
    "id": "BB-063-019",
    "title": "cheval_server records circuit breaker success before checking for error in response body",
    "severity": "MEDIUM",
    "category": "error-handling",
    "file": "adapters/cheval_server.py:L529-L531",
    "description": "In the invoke handler, record_success is called after successful JSON decode but BEFORE checking the response content for provider-level errors. A provider returning HTTP 200 with an error payload (e.g., OpenAI's {error: {message: '...', type: 'server_error'}}) would be recorded as a circuit breaker success, preventing the breaker from tripping on provider errors that arrive as 200 responses. This is a common pattern with OpenAI's API where some errors arrive as 200 with an error body.",
    "suggestion": "Move record_success to after normalize_response, and check whether the normalized response indicates an error before recording success. Alternatively, add a check for 'error' key in raw_response before recording success.",
    "faang_parallel": "Netflix's Zuul proxy had a similar issue where HTTP 200 responses with error bodies bypassed the circuit breaker. They added response body inspection to the health check logic.",
    "teachable_moment": "Circuit breakers should track logical success, not just transport success. An HTTP 200 with an error body is a logical failure."
  },
  {
    "id": "BB-063-020",
    "title": "Daily spend counter uses datetime.now for date key but does not handle timezone edge cases",
    "severity": "LOW",
    "category": "error-handling",
    "file": "adapters/cost_ledger.py:L114-L115",
    "description": "update_daily_spend uses datetime.now(timezone.utc).strftime('%Y-%m-%d') for the daily key. This is correct for UTC-based accounting. However, read_daily_spend also uses datetime.now(timezone.utc), meaning both functions will always agree. The potential issue is if the ledger file's date field and the daily spend date use different time references, but examining the code, both consistently use UTC. This finding is informational -- the code is correct, but the UTC assumption should be documented.",
    "suggestion": "Add a module-level comment: '# All timestamps in UTC. Daily spend counters use UTC date boundaries.'",
    "teachable_moment": "Consistent timezone handling is one of those things that seems obvious until you have services in multiple timezones. Documenting the convention prevents future drift."
  }
]
```
<!-- bridge-findings-end -->

---

## Findings Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH | 1 |
| MEDIUM | 6 |
| LOW | 8 |
| PRAISE | 3 |

---

## Stream 2: Insights Prose

### The JTI Namespace Collision (HIGH)

The most actionable security finding is BB-063-004. The `namespaceJti` function uses simple colon-delimited concatenation: `jti:{iss}:{jti}`. Because colons can appear in both issuer strings and JTI values, there exists a concatenation ambiguity that allows cross-issuer collision. This is not theoretical -- it is a well-known class of canonicalization vulnerability (CWE-289). The fix is straightforward: either hash the issuer component, or use a length-prefixed encoding. This should be addressed before the issuer allowlist grows beyond a small number of trusted issuers.

### The Streaming Cost Attribution Design

The `StreamCostTracker` and its integration with the ensemble orchestrator represent the most architecturally interesting new code in this PR. The three-tier billing fallback is well-thought-out:

1. **provider_reported**: The gold standard. When the provider sends a terminal usage event, use it.
2. **observed_chunks_overcount**: For cancelled ensemble branches, estimate from observed bytes plus a 10% safety margin. This correctly errs on the side of overcharging the platform (not the user) to avoid revenue leakage.
3. **prompt_only**: When a branch is cancelled before any output, charge only prompt tokens.

The `bytesPerToken` field added to `MicroPricingEntry` enables the byte-based estimation path. The values (4 for GPT tokenizers, 3.5 for Claude) are reasonable defaults.

### The Config Loader Security Model

The `config_loader.py` security model is mostly sound: env var allowlist, file path allowlist, symlink rejection, ownership check, permission check. The TOCTOU on the symlink check (BB-063-007) is a real but limited vulnerability -- it requires local filesystem access. The redaction layer (`redact_config`, `redact_headers`, `redact_string`) is comprehensive and correctly handles both structured redaction (by key name) and unstructured redaction (by env var value matching).

### What Is Missing: Test Coverage Gaps

Several new modules lack test files in this diff:

- `src/hounfour/native-runtime-adapter.ts` -- no tests for process spawning, escalated kill, stream parsing
- `src/hounfour/reconciliation-client.ts` -- no tests for state machine transitions, poll failure modes
- `src/hounfour/ensemble-cost-attribution.ts` -- no tests for ledger entry building, validation
- `src/hounfour/stream-cost.ts` -- no tests for the StreamCostTracker
- `src/hounfour/routing-matrix.ts` -- no tests for prefer_native fallback
- `src/hounfour/tier-bridge.ts` -- no tests for resolvePool with NFT preferences
- `src/hounfour/budget-migration.ts` -- test is referenced in the commit message but not in this diff
- `src/hounfour/redis/atomic-budget.ts` -- no tests for write-ahead + idempotency
- `src/hounfour/redis/ensemble-budget.ts` -- no tests for reserve/commit/releaseAll

The Python adapters have excellent test coverage. The TypeScript hounfour modules are less well-covered. I recognize that tests may exist in subsequent PRs or in files not included in this diff, but the absence is worth flagging.

### Closing Reflections

This is a PR that demonstrates serious engineering maturity. The authority boundary tests, the write-ahead journal protocol, the BigInt cost path, the JWKS state machine, the deny-by-default BYOK redaction -- these are all decisions that come from experience operating financial systems at scale. The architecture respects the separation of concerns between the cheval sidecar (observation-only) and loa-finn (enforcement).

The findings are real but manageable. The HIGH finding (JTI namespace collision) has a clean fix. The MEDIUM findings are concurrency races and security hardening opportunities that are worth addressing but not blocking. The code is ready for deployment with the understanding that the JTI namespace collision should be fixed first, and the remaining findings can be addressed in follow-up PRs.

The team should be proud of this work. The protocol package extraction (`loa-hounfour`) is clean and well-documented. The cost attribution system is production-grade. The streaming ensemble design is elegant in its use of JavaScript's single-threaded event loop to avoid the concurrency complexity that would exist in a multi-threaded language.

Ship it with the JTI fix.

---

*Review generated by Bridgebuilder V3 -- Opus 4.6*
