<!-- AGENT-CONTEXT: name=contributing-guide, type=operations, purpose=Developer contribution guide for Finn project, key_files=[package.json, tsconfig.json, src/index.ts, src/config.ts], interfaces=[], dependencies=[tsx, vitest, tsc], version=8d60958b2aa46facc5298b0f73252c084b74943e, priority_files=[package.json, src/index.ts, src/config.ts], trust_level=low, model_hints=[code,fast] -->

# Contributing to Finn

<!-- provenance: OPERATIONAL -->
Thank you for your interest in contributing to Finn. This guide covers development setup, workflow, code standards, testing, and the review process.

## Prerequisites

<!-- provenance: CODE-FACTUAL -->
- **Node.js** >= 22 (`package.json:47`)
- **Git** 2.x or later
- **Docker** (optional) — for containerized development (`deploy/Dockerfile:1`)

## Development Setup

### Clone and Install

<!-- provenance: OPERATIONAL -->
```bash
git clone https://github.com/0xHoneyJar/loa.git
cd loa
npm install
```

### Available Scripts

<!-- provenance: CODE-FACTUAL -->
Key scripts from `package.json:7`:

| Script | Command | Description |
|--------|---------|-------------|
| `dev` | `tsx --watch src/index.ts` | Development server with hot reload |
| `build` | `tsc` | TypeScript compilation to `dist/` |
| `typecheck` | `tsc --noEmit` | Type checking without emitting |
| `smoke` | `tsx scripts/smoke.ts` | Smoke tests |
| `test:finn` | (6-test suite) | Full Finn test suite |
| `test:upstream` | `vitest run` | Upstream library tests |

### Environment Variables

<!-- provenance: CODE-FACTUAL -->
Required environment variables are loaded from `.env` (gitignored). See `src/config.ts:1` for the full configuration schema. At minimum:

<!-- provenance: OPERATIONAL -->
- `FINN_AUTH_TOKEN` — Bearer token for API authentication
- `GITHUB_TOKEN` — GitHub API access (app token `ghs_` or PAT `ghp_`)

<!-- provenance: OPERATIONAL -->
Copy the example and fill in your values:

```bash
cp .env.example .env
```

### Docker Development

<!-- provenance: CODE-FACTUAL -->
A Docker Compose configuration is provided (`docker-compose.yml:1`):

```bash
docker compose up --build
```

<!-- provenance: CODE-FACTUAL -->
The service runs on port 3000 with a persistent data volume mounted at `/data` (`docker-compose.yml:9`). A GPU variant is available via `docker-compose.gpu.yml`.

## Project Structure

<!-- provenance: CODE-FACTUAL -->
Source code is organized into modules under `src/` (`src/index.ts:1`):

<!-- provenance: CODE-FACTUAL -->
| Directory | Purpose |
|-----------|---------|
| `src/gateway/` | HTTP and WebSocket API server |
| `src/hounfour/` | Multi-model orchestration |
| `src/persistence/` | WAL, R2 sync, Git backup |
| `src/scheduler/` | Periodic task management |
| `src/cron/` | Scheduled job system |
| `src/safety/` | Audit trail, tool registry, firewall |
| `src/agent/` | Session management and sandbox |
| `src/bridgebuilder/` | PR automation pipeline |
| `src/config.ts` | Configuration management |
| `src/shared/` | Shared utilities |
| `src/types/` | TypeScript type definitions |

## TypeScript Configuration

<!-- provenance: CODE-FACTUAL -->
The project uses strict TypeScript (`tsconfig.json:8`):

<!-- provenance: CODE-FACTUAL -->
- **Target**: ES2024 (`tsconfig.json:3`)
- **Module**: NodeNext (`tsconfig.json:4`)
- **Strict mode**: enabled
- **Output**: `dist/` directory (`tsconfig.json:6`)
- **Source maps**: enabled (`tsconfig.json:15`)

## Code Standards

### Style

<!-- provenance: OPERATIONAL -->
- Follow existing patterns in the codebase
- Use TypeScript strict mode — no `any` unless absolutely necessary
- Prefer explicit types over inference for public interfaces
- Keep functions focused — one responsibility per function

### Naming Conventions

<!-- provenance: OPERATIONAL -->
| Element | Convention | Example |
|---------|-----------|---------|
| Files | kebab-case | `jwt-auth.ts`, `rate-limit.ts` |
| Classes | PascalCase | `RateLimiter`, `AuditTrail` |
| Functions | camelCase | `validateJWT`, `safeCompare` |
| Constants | UPPER_SNAKE | `MAX_BODY_SIZE`, `HASH_METHODS` |
| Interfaces | PascalCase | `TokenBucket`, `FirewallConfig` |

### Security Requirements

<!-- provenance: OPERATIONAL -->
All contributions must follow the security practices documented in [SECURITY.md](SECURITY.md):

<!-- provenance: OPERATIONAL -->
- **Never commit secrets** — use environment variables
- **Validate all inputs** — especially external API data and user-provided values
- **Use timing-safe comparison** for any secret or token validation
- **Sanitize outputs** — prevent information disclosure in error messages
- **Log safely** — use the audit trail's built-in secret redaction

## Testing

### Test Framework

<!-- provenance: CODE-FACTUAL -->
Tests use `tsx` for direct TypeScript execution. Upstream library tests use **Vitest** (`package.json:21`).

### Test Locations

<!-- provenance: CODE-FACTUAL -->
| Location | Content |
|----------|---------|
| `tests/unit/` | Unit tests |
| `tests/integration/` | Integration tests |
| `tests/e2e/` | End-to-end tests |
| `tests/edge-cases/` | Edge case coverage |
| `tests/performance/` | Performance benchmarks |
| `tests/finn/` | Finn-specific test suite |
| `src/__tests__/` | Co-located unit tests |

### Running Tests

<!-- provenance: OPERATIONAL -->
```bash
# Full Finn test suite (6 tests)
npm run test:finn

# Individual test suites
npm run test:wal          # Write-ahead log
npm run test:persist      # Persistence integration
npm run test:cb           # Circuit breaker
npm run test:sandbox      # Agent sandbox
npm run test:compound     # Compound cycles
npm run test:bridgebuilder # BridgeBuilder pipeline

# Upstream library tests (Vitest)
npm run test:upstream

# Smoke test
npm run smoke
```

### Writing Tests

<!-- provenance: OPERATIONAL -->
- Name test files `*.test.ts`
- Co-locate unit tests in `src/__tests__/` or place in `tests/unit/`
- Test both success and failure paths
- Mock external dependencies (R2, Redis, GitHub API)
- Verify security-critical behavior explicitly (timing-safe comparison, redaction)

## Git Workflow

### Branch Naming

<!-- provenance: OPERATIONAL -->
| Type | Pattern | Example |
|------|---------|---------|
| Feature | `feature/description` | `feature/add-rate-limiting` |
| Bug fix | `fix/description` | `fix/jwt-replay-check` |
| Documentation | `docs/description` | `docs/update-api-reference` |
| Refactor | `refactor/description` | `refactor/persistence-layer` |
| CI/Infra | `ci/description` | `ci/add-security-scanning` |

### Commit Messages

<!-- provenance: OPERATIONAL -->
Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): short description

Longer description if needed.

Closes #123

Signed-off-by: Your Name <your.email@example.com>
```

<!-- provenance: OPERATIONAL -->
**Types**: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `ci`, `chore`

### Developer Certificate of Origin (DCO)

<!-- provenance: OPERATIONAL -->
All contributions require a DCO sign-off certifying you have the right to submit the code:

```bash
git commit -s -m "feat(gateway): add WebSocket rate limiting"
```

## Pull Request Process

### Creating a PR

<!-- provenance: OPERATIONAL -->
1. Create a feature branch from `main`
2. Make focused commits — one concern per PR
3. Run `npm run test:finn` and `npm run typecheck` locally
4. Push to your fork and open a PR using the [PR template](.github/PULL_REQUEST_TEMPLATE.md)
5. Link related issues with `Closes #123`

### Code Review

<!-- provenance: OPERATIONAL -->
All PRs require review from @janitooor (configured in `.github/CODEOWNERS`). The reviewer checks:

<!-- provenance: OPERATIONAL -->
- Correctness and completeness
- Test coverage for new code
- Security implications
- Architecture alignment with the [SDD](docs/architecture.md)
- Documentation updates where needed

### CI Requirements

<!-- provenance: CODE-FACTUAL -->
All PRs must pass the CI pipeline (`.github/workflows/ci.yml:1`):

<!-- provenance: OPERATIONAL -->
- **Secret scanning** — no credentials in code
- **Security audit** — no critical vulnerabilities
- **Type checking** — `tsc --noEmit` passes
- **Tests** — all test suites pass
- **Template guard** — framework artifacts are not modified

### Branch Protection

<!-- provenance: OPERATIONAL -->
The `main` branch requires:

<!-- provenance: OPERATIONAL -->
- At least 1 approval from CODEOWNERS
- All CI status checks passing
- No force pushes
- No direct pushes (PR only)

## What to Contribute

### Welcome

<!-- provenance: OPERATIONAL -->
- Bug fixes with test coverage
- Performance improvements with benchmarks
- Security hardening
- Documentation improvements
- New test coverage for edge cases

### Before Large Changes

<!-- provenance: OPERATIONAL -->
For significant changes (new modules, architectural modifications, API changes):

<!-- provenance: OPERATIONAL -->
1. Open an issue to discuss the proposal
2. Get maintainer feedback before implementing
3. Consider breaking into smaller PRs for easier review

## License

<!-- provenance: OPERATIONAL -->
By contributing to Finn, you agree that your contributions will be licensed under the [AGPL-3.0 License](LICENSE.md).
