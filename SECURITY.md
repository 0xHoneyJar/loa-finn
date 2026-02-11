<!-- AGENT-CONTEXT: name=security-policy, type=security, purpose=Security architecture and vulnerability reporting documentation, key_files=[src/gateway/auth.ts, src/hounfour/jwt-auth.ts, src/hounfour/jti-replay.ts, src/gateway/csrf.ts, src/gateway/rate-limit.ts, src/safety/audit-trail.ts, src/agent/sandbox.ts, src/safety/github-firewall.ts, src/safety/boot-validation.ts, src/safety/secret-redactor.ts], interfaces=[authMiddleware, validateJWT, JtiReplayGuard, RateLimiter, AuditTrail, FilesystemJail, GitHubFirewall], dependencies=[jose, node:crypto], version=8d60958b2aa46facc5298b0f73252c084b74943e, priority_files=[src/gateway/auth.ts, src/hounfour/jwt-auth.ts, src/safety/audit-trail.ts], trust_level=medium, model_hints=[reasoning,review] -->

# Security Policy

<!-- provenance: OPERATIONAL -->
This document describes the security architecture, threat mitigations, and vulnerability reporting procedures for Finn. All claims are grounded in source code with verifiable citations.

## Supported Versions

<!-- provenance: OPERATIONAL -->
| Version | Supported |
|---------|-----------|
| 0.2.x | Yes |
| 0.1.x | Yes |
| < 0.1 | No |

## Authentication Architecture

### Bearer Token Authentication

<!-- provenance: CODE-FACTUAL -->
All HTTP and WebSocket endpoints require Bearer token authentication via `src/gateway/auth.ts:14`. The token is validated using timing-safe comparison (`src/gateway/auth.ts:7`) — both the submitted and expected tokens are SHA-256 hashed before being compared with `timingSafeEqual` from Node.js crypto. This prevents timing side-channel attacks even when token lengths differ.

<!-- provenance: CODE-FACTUAL -->
WebSocket connections use the same timing-safe validation path (`src/gateway/auth.ts:36`). Dashboard authentication (`src/gateway/dashboard-auth.ts:38`) enforces a minimum token length of 32 characters (256 bits of entropy, `src/gateway/dashboard-auth.ts:57`).

### JWT Authentication (ES256)

<!-- provenance: CODE-FACTUAL -->
Service-to-service authentication uses ES256-signed JWTs (`src/hounfour/jwt-auth.ts:152`). The validation pipeline has four stages:

<!-- provenance: CODE-FACTUAL -->
1. **Structural pre-check** (`src/hounfour/jwt-auth.ts:86`) — validates 3-segment structure, `alg: ES256`, `typ: JWT` header before crypto operations
2. **Signature and claims** (`src/hounfour/jwt-auth.ts:176`) — verifies ES256 signature and standard claims (exp, nbf, iss, aud) via the `jose` library. On key-ID mismatch, refetches JWKS once to handle key rotation
3. **Custom claims** — validates tenant_id, tier, and req_hash
4. **JTI replay check** — see below

<!-- provenance: CODE-FACTUAL -->
JWKS keys are cached with a 5-minute TTL (`src/hounfour/jwt-auth.ts:44`). Cache invalidation is triggered on `kid` mismatch to handle dual-key rotation windows.

### JTI Replay Protection

<!-- provenance: CODE-FACTUAL -->
Every JWT's unique identifier (JTI) is tracked to prevent token replay. TTL is derived from the token's own expiry with a 60-second clock skew tolerance, clamped between 30 and 7200 seconds (`src/hounfour/jti-replay.ts:24`).

<!-- provenance: CODE-FACTUAL -->
Two guard implementations exist:

<!-- provenance: CODE-FACTUAL -->
- **In-memory** (`src/hounfour/jti-replay.ts:50`) — stores JTI with expiry timestamp. Periodic sweep every 60 seconds. Max 100k entries with oldest-first eviction
- **Redis-backed** (`src/hounfour/jti-replay.ts:134`) — uses `SET NX EX` for atomic check-and-store. **Fail-closed**: rejects as replay when Redis is unavailable (`src/hounfour/jti-replay.ts:140`)

### Request Body Integrity (req_hash)

<!-- provenance: CODE-FACTUAL -->
POST/PUT/PATCH requests with `application/json` content undergo body integrity verification (`src/hounfour/jwt-auth.ts:285`). The middleware computes `sha256:<hex>` of the raw request body (`src/hounfour/jwt-auth.ts:293`) and compares it against the JWT's `req_hash` claim using timing-safe comparison (`src/hounfour/jwt-auth.ts:359`). Maximum body size is 1 MB (`src/hounfour/jwt-auth.ts:285`).

### S2S JWT Signing

<!-- provenance: CODE-FACTUAL -->
Outbound service-to-service JWTs are signed with ES256 using PKCS8 PEM private keys (`src/hounfour/s2s-jwt.ts:33`). The protected header includes a versioned key ID (`kid`). Usage reports use JWS compact serialization over canonical JSON (`src/hounfour/s2s-jwt.ts:69`).

## Transport Security

### CORS

<!-- provenance: CODE-FACTUAL -->
CORS is enforced by `src/gateway/auth.ts:44`. Origins are validated against a configurable allowlist. Wildcard patterns are supported with safe regex construction: special characters are escaped (`src/gateway/auth.ts:75`) and `*` is replaced with `[a-zA-Z0-9.:-]*` (`src/gateway/auth.ts:76`). Non-wildcard patterns require exact match to prevent subdomain confusion (`src/gateway/auth.ts:80`). Malformed origins are rejected via URL parse failure (`src/gateway/auth.ts:66`).

### CSRF (Double-Submit Cookie)

<!-- provenance: CODE-FACTUAL -->
Browser-facing endpoints use double-submit cookie CSRF protection (`src/gateway/csrf.ts:72`). Tokens are 32 bytes of cryptographic randomness (64 hex characters) set as HttpOnly, SameSite=Strict cookies (`src/gateway/csrf.ts:64`). Validation compares the cookie value against a form field or `x-csrf-token` header using timing-safe comparison (`src/gateway/csrf.ts:99`).

<!-- provenance: CODE-FACTUAL -->
Safe methods (GET, HEAD, OPTIONS) bypass the check (`src/gateway/csrf.ts:74`). Requests with Bearer token authentication also bypass CSRF since they originate from API clients, not browsers (`src/gateway/csrf.ts:79`).

### Rate Limiting

<!-- provenance: CODE-FACTUAL -->
A token bucket rate limiter (`src/gateway/rate-limit.ts:11`) provides per-IP request throttling. Tokens refill based on elapsed time (`src/gateway/rate-limit.ts:32`). Stale buckets are cleaned up when idle for more than 2x the window duration (`src/gateway/rate-limit.ts:49`).

<!-- provenance: CODE-FACTUAL -->
Client IP extraction (`src/gateway/rate-limit.ts:64`) only trusts proxy headers (`CF-Connecting-IP`, `X-Forwarded-For`) when `trustProxy=true`, falling back to raw connection info to prevent IP spoofing via forged headers.

<!-- provenance: CODE-FACTUAL -->
The dashboard uses a separate sliding-window rate limiter (`src/gateway/dashboard-rate-limit.ts:28`) with a default of 60 requests per 60-second window and standard `X-RateLimit-*` response headers.

## Audit Trail

<!-- provenance: CODE-FACTUAL -->
All safety-critical operations are recorded in an append-only audit log (`src/safety/audit-trail.ts:383`). Each record contains an incrementing sequence number and a `prevHash` field linking to the previous record, forming a SHA-256 hash chain (`src/safety/audit-trail.ts:426`).

<!-- provenance: CODE-FACTUAL -->
Records are canonicalized with sorted keys before hashing (`src/safety/audit-trail.ts:140`), excluding the `hash` and `hmac` fields to ensure deterministic computation. Optional HMAC-SHA256 signing provides tamper evidence when a signing key is configured (`src/safety/audit-trail.ts:431`).

<!-- provenance: CODE-FACTUAL -->
Chain integrity can be verified by replaying all records and checking `prevHash` linkage, hash recomputation, and HMAC validity (`src/safety/audit-trail.ts:261`).

<!-- provenance: CODE-FACTUAL -->
Sensitive parameters are redacted before logging. Patterns matching `ghp_`, `ghs_`, `gho_`, `Bearer ` prefixes and keys named `token`, `secret`, `key`, `password` are replaced recursively through nested objects and arrays (`src/safety/audit-trail.ts:100`).

<!-- provenance: CODE-FACTUAL -->
Log rotation occurs at 10 MB with atomic rename to timestamped archive files (`src/safety/audit-trail.ts:168`).

## Tool Sandbox

<!-- provenance: CODE-FACTUAL -->
Agent tool execution runs through a multi-layer sandbox (`src/agent/sandbox.ts:180`):

<!-- provenance: CODE-FACTUAL -->
1. **Command allowlist** — only pre-registered commands are permitted (git, br, ls, cat, wc). Each has sub-command and flag restrictions (e.g., git allows `[log, status, diff, show, rev-parse]` but denies `[-c, --exec-path, --git-dir]`)
2. **Shell metacharacter rejection** (`src/agent/sandbox.ts:44`) — any command containing `|&;$\`(){}!<>\\#~` is rejected before execution
3. **Filesystem jail** (`src/agent/sandbox.ts:107`) — path prefix enforcement with symlink rejection. Each path component is checked via `lstatSync` to prevent symlink escape (`src/agent/sandbox.ts:124`)
4. **TOCTOU protection** (`src/agent/sandbox.ts:329`) — binaries are resolved via `realpathSync` at startup. Fails closed if binary is unresolvable
5. **Minimal environment** (`src/agent/sandbox.ts:48`) — strips all environment variables except PATH, HOME, LANG, TERM. Disables git pagers and config files, sets `GIT_TERMINAL_PROMPT=0`
6. **Fail-closed audit** (`src/agent/sandbox.ts:361`) — non-read-only commands are denied if audit log write fails. Read-only commands proceed in degraded mode with a warning

## GitHub Tool Firewall

<!-- provenance: CODE-FACTUAL -->
GitHub API operations pass through a 9-step enforcement pipeline (`src/safety/github-firewall.ts:123`):

<!-- provenance: CODE-FACTUAL -->
| Step | Gate | Action |
|------|------|--------|
| 0 | Unknown tool check | Reject unregistered tools |
| 1 | Admin capability denial | Deny + alert + audit |
| 2 | Deep parameter validation | must_be, pattern, allowlist |
| 3 | Dry-run interception | Intercept write tools in dry-run mode |
| 4 | Template policy | Per-tool allow/deny lists |
| 5 | Constraint application | Covered by step 2 |
| 6 | Rate limit check | Per-tool rate limiting |
| 7 | Write-ahead audit | Log intent before execution |
| 8 | Mutation deduplication | Prevent duplicate write operations |
| 9 | Execute + audit | Execute and log result/error |

<!-- provenance: CODE-FACTUAL -->
The tool registry (`src/safety/tool-registry.ts:48`) classifies tools as read, write, or admin. Write tools have constraints: `create_pull_request` enforces `draft=true` (`src/safety/tool-registry.ts:72`); branch operations require names matching `^(finn/|feature/|fix/|chore/)` (`src/safety/tool-registry.ts:75`). Admin tools (`merge_pull_request`, `delete_branch`, `update_branch_protection`) are always denied.

<!-- provenance: CODE-FACTUAL -->
Parameter validation (`src/safety/tool-registry.ts:149`) enforces three constraint types: `must_be` for exact value match, `pattern` for regex validation, and `allowlist` for enum validation.

## Boot Validation

<!-- provenance: CODE-FACTUAL -->
The server startup sequence includes safety validation (`src/safety/boot-validation.ts:71`):

<!-- provenance: CODE-FACTUAL -->
1. **Token type detection** — classifies tokens by prefix: `ghs_` (app token), `ghp_`/`github_pat_` (PAT). Autonomous mode requires app tokens (`src/safety/boot-validation.ts:166`)
2. **PID single-instance** (`src/safety/boot-validation.ts:219`) — checks for existing PID file, verifies if process is alive via `process.kill(pid, 0)`, warns on stale PID files
3. **Non-loopback auth enforcement** (`src/safety/boot-validation.ts:246`) — requires `FINN_AUTH_TOKEN` when binding to non-loopback addresses (not `127.0.0.1` or `::1`)
4. **Filesystem validation** (`src/safety/boot-validation.ts:80`) — detects filesystem type via `/proc/mounts`, rejects NFS/CIFS (O_EXCL unreliable), warns on overlayfs (rename may not be atomic), tests O_EXCL atomicity and rename via temp file

## Secret Management

### Credential Redaction

<!-- provenance: CODE-FACTUAL -->
A dedicated secret redactor (`src/safety/secret-redactor.ts:16`) detects and replaces known credential formats:

<!-- provenance: CODE-FACTUAL -->
| Pattern | Format |
|---------|--------|
| GitHub PAT (classic) | `ghp_[A-Za-z0-9_]{36,}` |
| GitHub PAT (fine-grained) | `github_pat_[A-Za-z0-9_]{22,}` |
| GitHub App token | `ghs_[A-Za-z0-9_]{36,}` |
| GitHub OAuth token | `gho_[A-Za-z0-9_]{36,}` |
| GitHub legacy token | `v[0-9]+\.[a-f0-9]{40}` |
| AWS access key | `AKIA[0-9A-Z]{16}` |
| Generic key/token | `(?:key\|token)=[a-f0-9]{32,}` |

<!-- provenance: CODE-FACTUAL -->
Error chain redaction (`src/safety/secret-redactor.ts:48`) walks the `cause` chain of Error objects, redacting `message`, `stack`, and nested causes. Cycle detection via `WeakSet` prevents infinite loops.

### Response Redaction

<!-- provenance: CODE-FACTUAL -->
HTTP responses pass through a deep-object redaction middleware (`src/gateway/redaction-middleware.ts:19`). Fields matching `/secret|token|password|key|credential|authorization/i` have their values replaced entirely (`src/gateway/redaction-middleware.ts:41`). String values are scanned for embedded secrets. Prototype pollution vectors (`__proto__`, `constructor`, `prototype`) are skipped during traversal (`src/gateway/redaction-middleware.ts:52`).

### Environment Variable Policy

<!-- provenance: OPERATIONAL -->
- All secrets must use environment variables — no hardcoded credentials in code
- `.env` files are gitignored
- The sandbox environment (`src/agent/sandbox.ts:48`) strips all variables except a minimal allowlist

## RBAC (Dashboard)

<!-- provenance: CODE-FACTUAL -->
Dashboard access control (`src/gateway/dashboard-auth.ts:79`) implements role-based checks. Localhost connections to a loopback-bound server receive implicit viewer access (`src/gateway/dashboard-auth.ts:89`). All operator-level actions require a valid Bearer token with timing-safe verification.

## Reporting a Vulnerability

<!-- provenance: OPERATIONAL -->
We take security seriously. If you discover a vulnerability:

### Private Disclosure (Preferred)

<!-- provenance: OPERATIONAL -->
1. **Do NOT create a public GitHub issue**
2. Email the security team at security@honeyjar.xyz with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact assessment
   - Suggested fixes (optional)
3. Expect a response within 48 hours
4. Coordinate disclosure timeline with maintainers

### What to Report

<!-- provenance: OPERATIONAL -->
- Authentication or authorization bypasses
- Injection vulnerabilities (command, code, prompt)
- Secret exposure risks
- Insecure default configurations
- Agent prompt injection vectors

### What NOT to Report

<!-- provenance: OPERATIONAL -->
- Vulnerabilities in upstream dependencies (report to upstream)
- Social engineering attacks
- Denial of service (unless critical)

## Vulnerability Disclosure Timeline

<!-- provenance: OPERATIONAL -->
| Day | Action |
|-----|--------|
| 0 | Vulnerability reported |
| 1-2 | Acknowledgment sent |
| 3-7 | Initial assessment complete |
| 8-30 | Fix developed and tested |
| 31-45 | Coordinated disclosure |

## Automated Security Scanning

<!-- provenance: OPERATIONAL -->
This repository uses:

<!-- provenance: OPERATIONAL -->
- **TruffleHog** — secret detection in commits
- **GitLeaks** — secret scanning
- **Dependabot** — dependency vulnerability alerts
- **CodeQL** — static code analysis

## Branch Protection

<!-- provenance: OPERATIONAL -->
The `main` branch is protected with required pull request reviews, required status checks, no force pushes, and no deletions.
