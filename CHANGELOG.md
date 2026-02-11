<!-- AGENT-CONTEXT: name=changelog, type=operations, purpose=Version history and release notes for Finn, key_files=[package.json, src/index.ts], interfaces=[], dependencies=[], version=8d60958b2aa46facc5298b0f73252c084b74943e -->

# Changelog

<!-- provenance: OPERATIONAL -->
All notable changes to Finn are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

<!-- provenance: OPERATIONAL -->
This changelog tracks Finn application changes. For Loa framework changes, see the upstream [Loa CHANGELOG](https://github.com/0xHoneyJar/loa/blob/main/CHANGELOG.md).

## [Unreleased]

### Added

<!-- provenance: OPERATIONAL -->
- Documentation rewrite: 16 ground-truth documents with quality gate verification (cycle-013)
- SECURITY.md with code-grounded security architecture documentation
- CONTRIBUTING.md with Finn-specific development guide
- CHANGELOG.md following Keep a Changelog format

### Changed

<!-- provenance: OPERATIONAL -->
- Archived legacy documentation to `docs/archive/`
- README.md rewritten with AGENT-CONTEXT and provenance tagging

## [0.2.0] - 2026-02-09

### Added

<!-- provenance: CODE-FACTUAL -->
- Hounfour Phase 5 integration hardening (`src/hounfour/router.ts:1`)
  - Multi-model orchestration with provider abstraction
  - finnNFT routing support
  - ES256 JWT service-to-service authentication
  - JTI replay protection with Redis and in-memory guards
  - Request body integrity verification (req_hash)

<!-- provenance: CODE-FACTUAL -->
- Bridgebuilder review hardening (`src/bridgebuilder/entry.ts:1`)
  - Shell pipeline security hardening
  - Hounfour security integration
  - Test infrastructure improvements

<!-- provenance: CODE-FACTUAL -->
- Ground-truth documentation tooling (`src/safety/audit-trail.ts:1`)
  - AST verification for code citations
  - Quality gate pipeline (9 gates)
  - Generation manifest tracking
  - Provenance tagging system

### Changed

<!-- provenance: OPERATIONAL -->
- Updated Loa framework to v1.31.0

## [0.1.0] - 2026-01-24

### Added

<!-- provenance: CODE-FACTUAL -->
- Hounfour Phase 3 — HTTP sidecar and streaming (`src/hounfour/router.ts:1`)
  - Cheval HTTP sidecar for tool-call orchestration
  - Server-Sent Events streaming
  - Redis state management
  - GPU deployment support via `docker-compose.gpu.yml`

<!-- provenance: CODE-FACTUAL -->
- Bridgebuilder autonomous PR review (`src/bridgebuilder/entry.ts:1`)
  - Adopted upstream Loa skill
  - Removed duplicated domain logic
  - Dashboard activity feed integration

<!-- provenance: CODE-FACTUAL -->
- Worker thread sandbox for non-blocking tool execution (`src/agent/sandbox.ts:1`)
  - Shell metacharacter rejection
  - Filesystem jail with symlink detection
  - Binary allowlist enforcement
  - TOCTOU protection via `realpathSync`

<!-- provenance: CODE-FACTUAL -->
- Persistence hardening (`src/persistence/wal.ts:1`)
  - Write-ahead log with R2 sync
  - Circuit breaker for external calls
  - Git backup integration

<!-- provenance: CODE-FACTUAL -->
- Dashboard with Bridgebuilder activity feed (`src/dashboard/activity-feed.ts:1`)

### Security

<!-- provenance: CODE-FACTUAL -->
- Timing-safe Bearer token authentication (`src/gateway/auth.ts:7`)
- CORS with safe regex construction (`src/gateway/auth.ts:44`)
- CSRF double-submit cookie protection (`src/gateway/csrf.ts:64`)
- Token bucket rate limiting (`src/gateway/rate-limit.ts:11`)
- SHA-256 hash chain audit trail with optional HMAC (`src/safety/audit-trail.ts:383`)
- GitHub tool firewall with 9-step enforcement pipeline (`src/safety/github-firewall.ts:123`)
- Boot validation with filesystem safety checks (`src/safety/boot-validation.ts:71`)
- Pattern-based secret redaction (`src/safety/secret-redactor.ts:16`)
- Response deep-object redaction middleware (`src/gateway/redaction-middleware.ts:19`)

## [0.0.1] - 2025-12-19

### Added

<!-- provenance: OPERATIONAL -->
- Initial Finn project setup
- Agentic base framework with 7 agent definitions
- Security audit remediation (CRITICAL, HIGH, MEDIUM, LOW findings)
- GitHub Actions CI pipeline
- Branch protection configuration
- CODEOWNERS setup

<!-- provenance: OPERATIONAL -->
### Infrastructure

- Docker and Docker Compose configuration (`deploy/Dockerfile`)
- GitHub Actions workflows: CI, security audit, secret scanning, shell lint
- PR template and branch protection rules

---

<!-- provenance: OPERATIONAL -->
## Versioning Note

<!-- provenance: OPERATIONAL -->
Finn follows [Semantic Versioning](https://semver.org/). The version in `package.json` reflects the application version. Development is organized in cycles (cycle-001 through cycle-013) which map to one or more minor version increments.

<!-- provenance: OPERATIONAL -->
| Cycle | Version | Focus |
|-------|---------|-------|
| 001-002 | 0.0.1 | Initial setup, security foundation |
| 003-005 | 0.1.0 | Persistence, sandbox, hounfour Phase 3 |
| 006-013 | 0.2.0 | Hounfour Phase 5, bridgebuilder, docs rewrite |
