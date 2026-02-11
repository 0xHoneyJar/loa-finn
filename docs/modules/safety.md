# Safety — Audit, Firewall & Redaction

<!-- AGENT-CONTEXT: name=safety, type=module, purpose=Security enforcement with hash-chained audit trail and execution isolation, key_files=[src/safety/audit-trail.ts, src/safety/github-firewall.ts, src/safety/secret-redactor.ts, src/safety/tool-registry.ts, src/safety/boot-validation.ts], interfaces=[AuditTrail, AlertService, GithubFirewall, SecretRedactor, ToolRegistry], dependencies=[], version=1ef38a64bfda4b35c37707c710fc9b796ada7ee5, priority_files=[src/safety/audit-trail.ts, src/safety/github-firewall.ts, src/safety/secret-redactor.ts], trust_level=low, model_hints=[reasoning,review] -->

## Purpose

<!-- provenance: CODE-FACTUAL -->
The safety module provides security enforcement, tamper-evident logging, and execution isolation. Its hash-chained audit trail records all agent actions with cryptographic integrity verification (`src/safety/audit-trail.ts:1`).

## Key Interfaces

### AuditTrail (`src/safety/audit-trail.ts`)

```typescript
class AuditTrail {
  record(input: AuditRecordInput): Promise<void>
  getRecords(opts: { since?, limit? }): AuditRecord[]
  async verifyChain(): Promise<VerifyResult>
  getRecordCount(): number
}
```

<!-- provenance: CODE-FACTUAL -->
**Hash chain**: Each record contains `hash` (SHA-256 of canonical JSON) and `prevHash` (link to previous). Optional HMAC-SHA256 signing via `hmac` field (`src/safety/audit-trail.ts:8`). Canonical serialization uses sorted keys, excluding `hash` and `hmac` fields (`src/safety/audit-trail.ts:141`).

<!-- provenance: CODE-FACTUAL -->
**Phases**: `intent` (before action), `result` (after success), `denied` (blocked), `dry_run` (simulation) (`src/safety/audit-trail.ts:37`).

<!-- provenance: CODE-FACTUAL -->
**Rotation**: 10MB file size threshold triggers new segment (`src/safety/audit-trail.ts:169`).

### AlertService (`src/safety/alert-service.ts`)

```typescript
class AlertService {
  async fire(severity, triggerType, context): Promise<boolean>
}
```

<!-- provenance: CODE-FACTUAL -->
Severities: `critical`, `error`, `warning`, `info` (`src/safety/alert-service.ts:10`). Channels: `github_issue`, `webhook`, `log` (`src/safety/alert-service.ts:13`).

### GithubFirewall (`src/safety/github-firewall.ts`)

<!-- provenance: INFERRED -->
Validates GitHub operations through a 3-phase protocol: intent → dry_run → result. Prevents unintended repository mutations.

### SecretRedactor (`src/safety/secret-redactor.ts`)

<!-- provenance: INFERRED -->
Pattern-based secret detection and replacement. Identifies API keys, tokens, passwords, PEM blocks, and other credential patterns.

### ToolRegistry (`src/safety/tool-registry.ts`)

<!-- provenance: INFERRED -->
Tool allowlist with policy enforcement. Controls which tools the agent can invoke and with what constraints.

### BootValidation (`src/safety/boot-validation.ts`)

<!-- provenance: INFERRED -->
Structured exit code system for boot failures. Returns specific codes to indicate missing config, unavailable services, or incompatible versions.

## Architecture

```
Agent Action → AuditTrail (intent phase)
                 │
                 ├─→ GithubFirewall (if GitHub operation)
                 │     └─→ dry_run phase → result phase
                 │
                 ├─→ ToolRegistry (policy check)
                 │
                 ├─→ SecretRedactor (output filtering)
                 │
                 └─→ AuditTrail (result/denied phase)
                       └─→ Hash chain verification
```

## Components (6 files)

| File | Responsibility |
|------|---------------|
| `audit-trail.ts` | SHA-256 hash chain, HMAC signing, 10MB rotation |
| `alert-service.ts` | Multi-channel alerting (GitHub, webhook, log) |
| `github-firewall.ts` | 3-phase GitHub operation validation |
| `secret-redactor.ts` | Credential pattern detection and replacement |
| `tool-registry.ts` | Tool allowlist and policy enforcement |
| `boot-validation.ts` | Structured boot failure exit codes |

## Dependencies

<!-- provenance: DERIVED -->
- **Internal**: `src/gateway/` (redaction middleware — `src/gateway/redaction-middleware.ts:7`), `src/agent/` (sandbox policy — `src/agent/sandbox.ts:35`)
- **External**: Node.js `crypto` (SHA-256, HMAC, timingSafeEqual)

## Known Limitations

<!-- provenance: INFERRED -->
- Audit trail is append-only with no deletion — rotation creates new segments but old segments remain
- Secret redaction is pattern-based — novel credential formats may not be detected

<!-- ground-truth-meta: head_sha=689a777 generated_at=2026-02-11T01:13:00Z features_sha=689a777 limitations_sha=689a777 ride_sha=689a777 -->
