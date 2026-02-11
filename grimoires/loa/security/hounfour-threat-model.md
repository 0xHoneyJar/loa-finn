# Hounfour Threat Model

> **Cycle**: 006 — The Hounfour
> **Author**: Claude Code (T-14.1)
> **Date**: 2026-02-08
> **Status**: Phase 0-2 (Foundation → Agent Portability)

---

## 1. Trust Boundaries

### 1.1 Boundary 1: User → Arrakis (Phase 4+)

**Trust Level**: Untrusted
**Phase**: Not implemented in Phase 0-2. Design-now for Phase 4.

| Assertion | Description |
|-----------|-------------|
| Authentication | JWT bearer token required per request |
| Authorization | Tenant tier determines model access (free/pro/enterprise) |
| Rate Limiting | Per-tenant RPM/TPM enforced at Arrakis edge |
| Input Validation | Prompt length capped, injection detection at edge |

**Attack Surfaces**:
- JWT forgery/replay
- Tenant escalation (free tier accessing enterprise models)
- Prompt injection at edge boundary

### 1.2 Boundary 2: Arrakis → loa-finn

**Trust Level**: Semi-trusted (internal service-to-service)
**Phase**: Phase 4+ (Arrakis not in scope for Phase 0-2)

| Assertion | Description |
|-----------|-------------|
| mTLS | Mutual TLS between Arrakis gateway and loa-finn |
| Tenant Context | JWT claims forwarded with tenant_id, nft_id, tier |
| Request Signing | HMAC signature on forwarded requests |

### 1.3 Boundary 3: loa-finn → cheval.py

**Trust Level**: Trusted subprocess (same machine, same user)
**Phase**: Phase 0 (implemented this cycle)

| Assertion | Description |
|-----------|-------------|
| HMAC Request Signing | Every ChevalRequest signed with HMAC-SHA256 |
| Scoped Environment | Only API key + HMAC secret + PATH passed to subprocess |
| Temp File Permissions | Request files written with 0600, deleted after use |
| No Shell Expansion | subprocess spawned with `execFile`, not `exec` |
| Stdout Contract | Only JSON on stdout; diagnostics on stderr only |

**Attack Surfaces**:
- Malicious cheval.py replacement (mitigated: file integrity, no download at runtime)
- Temp file race condition (mitigated: 0600 permissions, PID-scoped directory)
- Environment variable leakage (mitigated: explicit allowlist)
- Stderr information disclosure (mitigated: redaction rules)

### 1.4 Boundary 4: cheval.py → Provider API

**Trust Level**: External untrusted network
**Phase**: Phase 0 (implemented this cycle)

| Assertion | Description |
|-----------|-------------|
| TLS | All provider connections over HTTPS (enforced by httpx) |
| API Key Auth | Bearer token per provider, never logged |
| Request Isolation | One provider per subprocess invocation |
| Response Validation | CompletionResult schema validated before return |
| No Prompt Echo | Provider responses validated; prompt content not logged |

**Attack Surfaces**:
- Man-in-the-middle (mitigated: TLS certificate validation via httpx defaults)
- API key exfiltration (mitigated: scoped env, never in logs/stderr)
- Malicious response injection (mitigated: schema validation, type-safe parsing)
- Provider-side data retention (out of scope: governed by provider ToS)

---

## 2. HMAC Request Signing Specification

### 2.1 Algorithm

- **Algorithm**: HMAC-SHA256
- **Key**: `CHEVAL_HMAC_SECRET` environment variable (32 bytes minimum)
- **Encoding**: Hex-encoded signature string (64 characters)

### 2.2 Canonical Bytes-to-Sign

The signature is computed over a canonical JSON string with the following rules:

1. **Fields included** (in this order):
   - `nonce`: Random 32-character hex string (unique per request)
   - `trace_id`: UUID v4 from request metadata
   - `issued_at`: ISO 8601 timestamp (UTC, millisecond precision)
   - `body_hash`: SHA-256 hex digest of the full ChevalRequest JSON body

2. **Canonical JSON serialization**:
   - Keys sorted alphabetically
   - UTF-8 encoding
   - No trailing whitespace
   - No pretty-printing (compact JSON)

```typescript
// TypeScript signing (ChevalInvoker)
function signRequest(body: string, secret: string, nonce: string, traceId: string, issuedAt: string): string {
  const bodyHash = crypto.createHash("sha256").update(body, "utf8").digest("hex")
  const canonical = JSON.stringify({
    body_hash: bodyHash,
    issued_at: issuedAt,
    nonce: nonce,
    trace_id: traceId,
  }) // Keys already sorted alphabetically
  return crypto.createHmac("sha256", secret).update(canonical, "utf8").digest("hex")
}
```

```python
# Python verification (cheval.py)
def verify_hmac(body: bytes, signature: str, secret: str, nonce: str, trace_id: str, issued_at: str, skew_seconds: float = 30.0) -> bool:
    body_hash = hashlib.sha256(body).hexdigest()
    canonical = json.dumps({
        "body_hash": body_hash,
        "issued_at": issued_at,
        "nonce": nonce,
        "trace_id": trace_id,
    }, sort_keys=True, separators=(",", ":"))
    expected = hmac.new(secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        return False
    # Clock skew validation
    issued = datetime.fromisoformat(issued_at.replace("Z", "+00:00"))
    delta = abs((datetime.now(timezone.utc) - issued).total_seconds())
    return delta <= skew_seconds
```

### 2.3 Clock Skew Tolerance

- **Default**: 30 seconds
- **Configurable**: Via `CHEVAL_HMAC_SKEW_SECONDS` environment variable
- **Behavior**: Requests with `issued_at` outside the skew window are rejected with exit code 3

### 2.4 Replay Prevention

- **Nonce**: 32-character hex random string generated per request
- **Nonce Cache**: In-memory LRU cache (capacity: 10,000) in cheval.py
- **Duplicate Detection**: Requests with previously-seen nonce within skew window are rejected
- **Note**: Phase 0-2 subprocess mode creates a new process per request, so nonce cache is per-invocation only. Full replay prevention requires persistent nonce storage (Phase 3+).

### 2.5 Interop Test Specification

Required test: TypeScript signs a ChevalRequest, Python verifies it.

```
Given:
  secret = "test-hmac-secret-32-bytes-long!!"
  nonce = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"
  trace_id = "550e8400-e29b-41d4-a716-446655440000"
  issued_at = "2026-02-08T12:00:00.000Z"
  body = '{"schema_version":1,"model":"gpt-4o","messages":[{"role":"user","content":"hello"}]}'

Then:
  body_hash = sha256(body)
  canonical = '{"body_hash":"<hash>","issued_at":"2026-02-08T12:00:00.000Z","nonce":"a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4","trace_id":"550e8400-e29b-41d4-a716-446655440000"}'
  signature = hmac_sha256(secret, canonical) → must match between TS and Python
```

### 2.6 Negative Test Scenarios

1. **Encoding difference**: Body encoded as Latin-1 vs UTF-8 → signature mismatch
2. **Replay attempt**: Same nonce reused within skew window → rejected
3. **Clock skew exceeded**: `issued_at` 60s in the past with 30s tolerance → rejected
4. **Tampered body**: Body modified after signing → `body_hash` mismatch → rejected
5. **Missing HMAC fields**: Request without `hmac.signature` → rejected with exit code 3

---

## 3. HMAC Secret Lifecycle

### 3.1 Secret Source

- **Environment variable**: `CHEVAL_HMAC_SECRET`
- **Minimum length**: 32 bytes (256 bits)
- **Generation method**: `openssl rand -hex 32` or equivalent CSPRNG

### 3.2 Local Development Bootstrap

When `CHEVAL_HMAC_SECRET` is not set:
1. Auto-generate a random 32-byte hex secret
2. Log warning: `[hounfour] WARNING: Auto-generated HMAC secret for local development. Set CHEVAL_HMAC_SECRET for production.`
3. Store in memory only (not persisted to disk)

### 3.3 Rotation Cadence

- **Phase 0-2**: Manual rotation (operator sets new env var, restarts)
- **Phase 3+**: Automated rotation via secret manager integration

### 3.4 Zero-Downtime Rotation

During rotation, both old and new secrets must work simultaneously:

1. Set `CHEVAL_HMAC_SECRET_PREV` to the current secret
2. Set `CHEVAL_HMAC_SECRET` to the new secret
3. ChevalInvoker signs with new secret
4. cheval.py verifies with new secret first, falls back to `CHEVAL_HMAC_SECRET_PREV`
5. After overlap window (recommended: 1 hour), remove `CHEVAL_HMAC_SECRET_PREV`

---

## 4. Credential Validation Specification

### 4.1 Startup API Key Check

At boot time (step 6e), for each enabled provider with `type != "claude-code"`:

1. **Check presence**: Verify API key is non-empty after `{env:VAR}` interpolation
2. **Validation request**: Send lightweight validation request (provider-specific):
   - OpenAI: `GET /v1/models` with Bearer token (expect 200)
   - OpenAI-compatible: `GET {baseURL}/models` with Bearer token (expect 200)
3. **On failure**: Log error with provider name, continue boot (degraded mode)
4. **On success**: Mark provider as `validated` in registry

### 4.2 Error Messages

| Scenario | Message |
|----------|---------|
| Missing API key | `[hounfour] ERROR: Provider "{name}" has no API key. Set {env_var} or disable provider.` |
| Invalid API key | `[hounfour] ERROR: Provider "{name}" API key validation failed: {status} {statusText}` |
| Network error | `[hounfour] WARN: Provider "{name}" unreachable at startup: {error}. Will retry at runtime.` |

### 4.3 Environment Variable Allowlist

The `{env:VAR}` interpolation pattern in provider config only resolves variables matching:

- `*_API_KEY` (e.g., `OPENAI_API_KEY`, `MOONSHOT_API_KEY`)
- `CHEVAL_*` (e.g., `CHEVAL_HMAC_SECRET`)

Any other variable name triggers a warning:
`[hounfour] WARN: Env var "{name}" does not match allowlist pattern. Rejecting interpolation.`

### 4.4 Redaction Rules for Logs

Never print to any log output:
- API keys (full or partial)
- HMAC secrets
- Request bodies containing prompts
- Authorization headers
- `{env:VAR}` resolved values

---

## 5. Penetration Test Scenarios — Cheval Invocation Bypass

### 5.1 Direct cheval.py Invocation Without HMAC

**Scenario**: Attacker invokes `python3 cheval.py --request /tmp/malicious.json` directly.
**Expected**: cheval.py rejects request (exit code 3) because HMAC validation fails.
**Test**: Create request file without HMAC fields, invoke cheval.py, assert exit code 3.

### 5.2 HMAC Replay Attack

**Scenario**: Attacker captures a valid signed request and replays it.
**Expected**: Rejected if nonce already seen (Phase 3+ with persistent cache) or if outside clock skew window.
**Phase 0-2 limitation**: Per-process nonce cache means replay within same process is caught, but cross-process replay within skew window is possible. Acceptable for local-only deployment.

### 5.3 Environment Variable Extraction

**Scenario**: Malicious tool execution attempts to read `CHEVAL_HMAC_SECRET` from process environment.
**Expected**: ChevalInvoker passes scoped environment to subprocess (explicit allowlist). Parent process env vars not inherited.
**Test**: In cheval.py, attempt to read `ANTHROPIC_API_KEY` — should be undefined.

### 5.4 Temp File Snooping

**Scenario**: Attacker monitors `/tmp/cheval-{pid}/` for request files.
**Expected**: Files created with 0600 permissions (owner-only read/write), deleted immediately after subprocess exits.
**Test**: Verify file permissions are 0600. Verify file is deleted after invocation completes (success or failure).

### 5.5 Stdout Injection

**Scenario**: Malicious provider returns crafted response that, when parsed, could inject data.
**Expected**: cheval.py validates response against CompletionResult schema before outputting to stdout. Malformed responses produce ChevalError JSON, not raw provider output.

---

## 6. JWT Specification (Phase 4 — Design Now)

### 6.1 Token Format

- **Standard**: RFC 7519 (JSON Web Token)
- **Algorithm**: RS256 (RSA with SHA-256)
- **Issuer**: `arrakis.loa.dev`

### 6.2 Required Claims

| Claim | Type | Description |
|-------|------|-------------|
| `iss` | string | Issuer: `arrakis.loa.dev` |
| `sub` | string | Tenant ID (wallet address or internal ID) |
| `aud` | string | Audience: `loa-finn` |
| `exp` | number | Expiration (Unix timestamp, max 1 hour) |
| `iat` | number | Issued at (Unix timestamp) |
| `jti` | string | Unique token ID (for revocation) |
| `tier` | string | Tenant tier: `free`, `pro`, `enterprise` |
| `nft_id` | string | NFT token ID (empty string if none) |
| `models` | string[] | Allowed model aliases for this tier |

### 6.3 Validation Rules

1. Verify RS256 signature against Arrakis public key
2. Check `exp > now` (not expired)
3. Check `iat < now + 60s` (not issued in future with 60s clock skew)
4. Check `iss == "arrakis.loa.dev"`
5. Check `aud == "loa-finn"`
6. Check `tier` is valid enum value
7. Check `models` array is non-empty

### 6.4 Key Rotation

- Public keys fetched from Arrakis JWKS endpoint: `https://arrakis.loa.dev/.well-known/jwks.json`
- Keys cached for 1 hour with background refresh
- Key ID (`kid`) in JWT header used for key lookup

---

## 7. BYOK (Bring Your Own Key) Liability Model

### 7.1 Phase 0-2 (Current)

All API keys are operator-managed. The operator (deployer) is responsible for:
- Key generation and storage
- Key rotation
- Cost monitoring
- Usage within provider ToS

### 7.2 Phase 4+ (Arrakis Multi-Tenant)

When tenants provide their own API keys:

| Responsibility | Owner |
|---------------|-------|
| Key storage | Tenant (encrypted at rest in tenant config) |
| Key validation | loa-finn (startup + periodic) |
| Cost tracking | loa-finn (per-tenant metering) |
| Rate limiting | loa-finn (per-tenant, per-provider) |
| Key rotation | Tenant (self-service via Arrakis dashboard) |
| Abuse detection | loa-finn (anomaly detection on usage patterns) |
| Liability for charges | Tenant (explicit ToS acknowledgment) |

### 7.3 Security Invariants (All Phases)

1. API keys are never logged, even partially
2. API keys are never stored in WAL or cost ledger
3. API keys are never included in health check responses
4. API keys are resolved from environment at construction time, not per-request
5. Failed key validation does not expose the key in error messages

---

## 8. Security Invariants Per Phase

### Phase 0 (Foundation)
- HMAC signing on all cheval.py invocations
- Scoped subprocess environment
- Temp file security (0600, auto-delete)
- Schema validation on all inputs/outputs
- Stderr redaction (no secrets, no prompts, no API keys)

### Phase 1 (Flatline Integration)
- Budget enforcement prevents cost overrun
- Tool-call loop bounded (max iterations, wall time, total calls)
- Persona injection detection
- Idempotency prevents duplicate tool execution

### Phase 2 (Agent Portability)
- Circuit breaker prevents cascading failures
- Fallback/downgrade chains enforce capability requirements
- Health probes do not leak internal state
- Rate limiting prevents provider abuse

### Phase 3+ (Server Integration)
- Library mode removes subprocess overhead but maintains HMAC for auditing
- Connection pooling per provider with TLS pinning
- Streaming response validation

### Phase 4+ (Distribution)
- JWT authentication at Arrakis edge
- Per-tenant isolation (no cross-tenant data access)
- BYOK key encryption at rest
- Audit trail for all model invocations
