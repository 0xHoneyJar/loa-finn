# CI Failure Classification — Security Audit / Dependency Scan / E2E

Local classification of the recurring red checks that blocked recent PRs
(#249, #250, #251). Each failure is classified as fixed-here, environmental,
or accepted-with-rationale; nothing is silenced without a documented reason.

## 1. Dependency audit failures (#250)

`pnpm audit --audit-level high` was failing on 10 high advisories. Local
remediation (2026-07-03), without changing the audit level or thresholds:

| Advisory | Package (path) | Action |
|----------|----------------|--------|
| GHSA-vxpw-j846-p89q, GHSA-hm92-r4w5-c3mj | `undici` via `@mariozechner/pi-ai` | Override → `7.28.0` |
| hono JWT audience bypass (<4.12.25) | `hono` (direct) | Bumped to `^4.12.27` + override floor raised |
| protobufjs (<=7.6.0) | via `@google/genai` | Override → `7.6.1` |
| ws DoS (<8.21.0) | via `siwe > ethers` | Override → `8.21.0` |
| GHSA-fx2h-pf6j-xcff | `vite` 8.0.x (vitest peer) | Explicit devDependency `vite@^8.1.3` (overrides do not rewrite auto-installed peers) |
| GHSA-7v5m-pr3q-6453, GHSA-jfgx-wxx8-mp94, GHSA-r95r-rj6r-c39x | `@mariozechner/pi-coding-agent` (direct, `~0.52.6`) | **Accepted, documented ignore** — see below |

### Accepted ignores (pi-coding-agent)

All three advisories cover `>=0.50.0 <=0.73.1` with **no patched release**
(0.73.1 is the latest published version and is itself in range). There is no
upgrade that clears them. Affected surfaces are operator-side tooling paths
(HTML session exports, extension install paths on shared hosts, local
auth.json writes), not the request-serving gateway. They are listed in
`package.json → pnpm.auditConfig.ignoreGhsas` with this document as the
rationale. **Removal trigger**: delete the ignores the moment upstream
publishes a version outside the vulnerable range.

Post-remediation state: `pnpm audit --audit-level high` exits 0. Remaining
moderate/low advisories are below the gate threshold by design (see the
workflow comment in `.github/workflows/security-audit.yml`).

## 2. Node runtime misalignment (#244, contributes to #250)

`package.json` declares `engines.node: >=22`, but several workflows installed
and audited under Node 20 (`security-audit.yml`, `ci.yml`, `deploy*.yml`,
`secret-scanning.yml`). All aligned to Node 22 so the security gates run on
the runtime the package declares as supported.

## 3. Secret scanning (#249)

The Secret Scanning failure reported on PR #239 does not reproduce on the
current branch: `Scan for Secrets` is green on PR #259's head. Classification:
the failure was specific to PR #239's docs-lane content (now closed), not a
repo-wide condition. No allowlist or scanner configuration was changed.

## 4. Legacy E2E failures (#251, #242)

The `e2e` workflow provisions postgres + redis + finn only
(`docker-compose.dev.yml`), but the suite included three-service tests that
dial Freeside (:3002) and Dixie (:3003) by default — those 17 failures are
**structural** (services never provisioned), not regressions. Fix (not a
mask): Freeside/Dixie-dependent suites in `tests/e2e/full-flow.test.ts` and
`tests/e2e/jwt-exchange.test.ts` now gate on explicit `E2E_FREESIDE_URL` /
`E2E_DIXIE_URL` configuration and appear as named skips otherwise, and
`tests/e2e/target-coverage.test.ts` prints an `[e2e-targets]` line so
Finn-only evidence can never masquerade as three-service coverage. Full
three-service coverage remains available by setting the env vars against a
complete stack.
