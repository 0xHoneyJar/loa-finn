# PRD: Staging Readiness — Goodhart Wiring, ECS Staging, Fly.io Cleanup

**Status:** Draft
**Author:** Jani + Claude
**Date:** 2026-02-26
**Cycle:** 036
**References:** [Launch Readiness #66](https://github.com/0xHoneyJar/loa-finn/issues/66) · [Bridgebuilder Review PR #108](https://github.com/0xHoneyJar/loa-finn/pull/108#issuecomment-3964422678) · [Dixie Loop Closure #66 Round 12](https://github.com/0xHoneyJar/loa-finn/issues/66#issuecomment-3959406797)

---

## 1. Problem Statement

Cycle-035 shipped the complete Goodhart protection stack — reputation adapter, dixie transport, temporal decay, exploration, calibration, kill switch, mechanism interaction — but **none of it is instantiated at runtime**. `src/index.ts:304` creates a `HounfourRouter` with deterministic routing only. The entire reputation-aware routing path (`resolvePoolWithReputation()`) is never called.

Meanwhile, the codebase contains stale deployment references to Fly.io and Railway that contradict the actual infrastructure (ECS Fargate via `deploy.yml`). No staging environment exists — the only deployment target is `honeyjar-production`.

The goal of this cycle is to:
1. Connect the built-but-disconnected Goodhart stack to the live routing path
2. Remove all Fly.io/Railway references (ECS-only deployment)
3. Stand up a staging ECS service with Gibson-named environments
4. Fix CI E2E workflows so they pass

> Source: Issue #66 Round 12 critical path: `Wire ReputationQueryFn → Goodhart protection → E2E test → Loop is live`

---

## 2. Goals & Success Metrics

| Goal | Metric | Target |
|------|--------|--------|
| Goodhart stack wired | `resolveWithGoodhart()` called on every routing decision | 100% of requests in shadow+ modes |
| Staging deployed | `finn.armitage.arrakis.community/health` returns 200 | Accessible |
| Shadow mode functional | `finn_shadow_total` counter increments on staging | >0 after 10 requests |
| Fly.io/Railway removed | `grep -r "fly.io\|railway\|flyctl" src/ deploy/ .github/` | 0 matches |
| CI E2E green | E2E workflow passes on PR | All jobs pass or gracefully skip |

---

## 3. Users & Stakeholders

| Persona | Need |
|---------|------|
| **Operator (Jani)** | Deploy finn to staging, observe shadow metrics, validate graduation path |
| **Finn (the service)** | Route requests through reputation-aware path with Goodhart protection |
| **Dixie (future)** | Receive reputation queries from finn (stubbed for now, real wiring in next cycle) |
| **CI** | E2E tests pass without missing secrets or Docker image access errors |

---

## 4. Functional Requirements

### FR-1: Goodhart Stack Wiring

Connect all Goodhart components in `src/index.ts` initialization:

| Component | Class | Config Source |
|-----------|-------|---------------|
| Kill Switch | `KillSwitch` | `RuntimeConfig` (Redis) + `FINN_REPUTATION_ROUTING` env |
| Dixie Transport | Transport factory | `DIXIE_BASE_URL` env: unset/`"stub"` → `DixieStubTransport`; URL → `DixieHttpTransport` |
| Temporal Decay | `TemporalDecayEngine` | Redis client, default half-life (7d task, 30d aggregate) |
| Exploration | `ExplorationEngine` | Redis client, epsilon from env or default 0.05 |
| Calibration | `CalibrationEngine` | S3 bucket + HMAC key (optional, degrades gracefully) |
| Reputation Adapter | `ReputationAdapter` | Composes transport + decay + calibration |
| Mechanism Interaction | `resolveWithGoodhart()` | Composes all above |

**Routing State Machine:**

| State | Trigger | Goodhart Invoked? | Result Used? | Side Effects |
|-------|---------|-------------------|--------------|-------------|
| `disabled` | `FINN_REPUTATION_ROUTING=disabled` | No — skip entirely | N/A | None |
| `shadow` | `FINN_REPUTATION_ROUTING=shadow` (default) | Yes — full pipeline | No — deterministic result returned | Redis reads (EMA, exploration counters), metrics incremented |
| `enabled` | `FINN_REPUTATION_ROUTING=enabled` | Yes — full pipeline | Yes — reputation-aware result | Redis reads/writes, metrics, audit log |
| `init_failed` | Goodhart init throws | No — components not available | N/A | `finn_goodhart_init_failed` counter incremented |

**Transport Factory:**
Transport selection via `DIXIE_BASE_URL` env var:
- Unset or `"stub"` → `DixieStubTransport` (returns `null`, zero behavioral change)
- Any URL → `DixieHttpTransport` (real HTTP, for future cycles)

**Acceptance Criteria:**
- AC1: `HounfourRouter` receives a `reputationQueryFn` backed by `ReputationAdapter`
- AC2: In `shadow` mode, `resolveWithGoodhart()` is invoked but deterministic result is returned; shadow metrics (`finn_shadow_total`, `finn_shadow_diverged`) are incremented
- AC3: In `enabled` mode, reputation-aware routing result is used
- AC4: In `disabled` mode, Goodhart components are not constructed or invoked
- AC5: If Goodhart init fails (Redis down, import error), routing falls back to deterministic with `finn_goodhart_init_failed` counter; no request-path retries
- AC6: Transport factory: `DIXIE_BASE_URL` unset/`"stub"` → `DixieStubTransport`; URL value → `DixieHttpTransport`

### FR-2: Parallel Reputation Scoring

- AC7: `resolvePoolWithReputation()` scores pools via `Promise.allSettled` instead of sequential `for...of + await`
- AC8: Individual pool scoring failures don't block other pools

> Source: Bridgebuilder MEDIUM-1 from PR #107

### FR-3: Fly.io / Railway Removal

Remove all references to Fly.io and Railway from the codebase:

| File | Action |
|------|--------|
| `railway.toml` (root) | Delete |
| `deploy/railway.toml` | Delete |
| `deploy/BRIDGEBUILDER.md` | Remove Railway sections, update for ECS |
| `deploy/vllm/README.md` | Remove Fly.io GPU section |
| `deploy/wrangler.jsonc` | Delete (Cloudflare Workers — not used) |
| `README.md` | Remove Railway/Fly.io references |
| `CHANGELOG.md` | Leave historical entries (they're factual history) |
| `.claude/settings.json` | Remove `fly:*`, `railway:*` permission entries |
| `docs/operations.md` | Remove Railway section |
| `docs/modules/bridgebuilder.md` | Update deployment references |
| `grimoires/loa/context/bridgebuilder-minimal-railway.md` | Delete |
| `grimoires/loa/context/research-minimal-pi.md` | Remove Fly.io fallback references |
| `grimoires/loa/sdd-bridgebuilder-refactor.md` | Remove Railway references |
| `grimoires/loa/sdd-product-launch.md` | Remove Fly.io references |

**Acceptance Criteria:**
- AC9: Zero matches for `fly.io`, `flyctl`, `railway.toml`, `railway.app` in `src/`, `deploy/`, `.github/`, `docs/`
- AC10: `deploy/fly.toml` and `deploy/wrangler.jsonc` do not exist
- AC11: CHANGELOG.md historical entries preserved (don't rewrite history)

### FR-4: ECS Staging Environment

Stand up a staging ECS service using existing freeside/arrakis AWS infrastructure.

**Gibson Naming Convention:**
Staging environments use alphabetical names from Gibson's Neuromancer trilogy:
- `finn.armitage.arrakis.community` — first staging environment
- `finn.chiba.arrakis.community` — second (if needed)
- `finn.dixieflat.arrakis.community` — third
- `finn.freeside.arrakis.community` — fourth
- Pattern: `finn.<gibson-name>.arrakis.community`

**Infrastructure (additive to existing):**
- New ECS service: `loa-finn-armitage` in existing cluster
- New ALB target group: `finn-armitage-tg` on existing ALB
- New HTTPS listener rule (port 443): Host header `finn.armitage.arrakis.community` → target group
- ACM certificate: wildcard `*.arrakis.community` (or explicit SAN) attached to ALB HTTPS listener — **verify existing cert covers subdomain pattern `finn.*.arrakis.community`; if not, request new cert**
- Route53 ALIAS record (not CNAME) pointing `finn.armitage.arrakis.community` → ALB DNS name
- Task definition: same as production but with staging env vars

**Staging-specific configuration:**
```
ROUTING_MODE=shadow
X402_SETTLEMENT_MODE=verify_only
FINN_REPUTATION_ROUTING=shadow
NODE_ENV=production
# DIXIE_BASE_URL intentionally unset → DixieStubTransport
```

**Acceptance Criteria:**
- AC12: `https://finn.armitage.arrakis.community/health` returns 200 with valid TLS
- AC13: Staging task definition uses shadow mode defaults
- AC14: Staging deploy workflow triggered by manual dispatch or tag
- AC15: Terraform module parameterized for environment name (armitage, chiba, etc.)
- AC16: `deploy/staging.env.example` documents all staging env vars

### FR-5: CI E2E Fix

Fix the 3 failing E2E CI workflows:

| Workflow | Current Failure | Fix |
|----------|----------------|-----|
| `e2e-smoke.yml` | `ARRAKIS_CHECKOUT_TOKEN` missing | Make cross-repo checkout conditional, skip entire job gracefully if secret missing |
| `e2e.yml` | `deploy/build-context/oracle-*` directories missing | Oracle knowledge/persona directories are optional for core finn functionality. Make Dockerfile COPY conditional (`COPY --from=... || true` pattern or multi-stage with optional layer). Commit minimal test fixtures (`deploy/build-context/oracle-knowledge/.gitkeep`, `deploy/build-context/oracle-persona/.gitkeep`) so Docker build succeeds. Oracle features degrade gracefully when corpus is empty. |
| `e2e-v2.yml` | GHCR `loa-freeside:v7.11.0` access denied | Add GHCR login step using `ARRAKIS_CHECKOUT_TOKEN`. If token unavailable, skip job with clear message. |

**Acceptance Criteria:**
- AC17: E2E workflows pass or gracefully skip when secrets are unavailable (skip message includes which secret is missing)
- AC18: Docker build succeeds with empty oracle directories; minimal `.gitkeep` fixtures committed to repo
- AC19: When oracle corpus is absent, finn starts successfully with oracle features disabled (existing graceful degradation at `src/index.ts:289-301`)

---

## 5. Technical & Non-Functional Requirements

**Request-path constraints:**
- No synchronous S3 calls on the request path. Calibration data is loaded async at startup and refreshed on a polling interval (default 60s). Request-path reads only hit in-memory cache.
- Redis reads on request path: kill switch mode check (~0.1ms LAN), EMA lookup (~0.1ms LAN), exploration counter increment (best-effort, non-blocking). All Redis calls have 50ms timeouts; failures degrade to deterministic.
- `DixieStubTransport` is synchronous in-memory (`return null`) — zero network overhead.

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| Startup time with Goodhart | <5s additional | `console.time` around Goodhart init block |
| Shadow mode p95 overhead | <5ms per request | Histogram delta: `finn_routing_duration_seconds` with/without Goodhart (staging) |
| Reputation stub latency | <0.1ms | In-memory, no network — verified by unit test |
| Staging monthly cost | <$50 | Fargate spot pricing, min capacity 0, desired 1 |

---

## 6. Scope

### In Scope
- Wire Goodhart stack to routing path (all components exist, just disconnected)
- Transport factory implemented (stub + HTTP); staging uses stub only (`DIXIE_BASE_URL` unset)
- Parallel reputation scoring
- Remove Fly.io/Railway references
- ECS staging with Gibson naming
- CI E2E workflow fixes
- Terraform for staging service

### Out of Scope (Future Cycles)
- Exercising DixieHttpTransport in staging (requires staging dixie service; transport factory implemented but `DIXIE_BASE_URL` left unset)
- x402 settlement mode `live` (stays `verify_only`)
- Graduation ceremony (requires 72h of staging data)
- Per-NFT personality (BEAUVOIR.md)
- JWKS key rotation
- Multi-tenant trust boundary
- Production deployment

---

## 7. Risks & Dependencies

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Redis unavailable on staging | Medium | Low | Goodhart stack degrades to deterministic — tested |
| S3 calibration bucket missing | Medium | Low | CalibrationEngine returns empty — no behavioral change |
| Existing ALB listener rules conflict | Low | Medium | Use unique priority number, validate with Terraform plan |
| Terraform state drift | Low | High | Import existing resources before applying |

### Dependencies
- Existing ECS cluster in freeside AWS account
- Route53 zone for `arrakis.community`
- ALB with available listener rule slots
- Redis instance (ElastiCache or equivalent)

---

## 8. Implementation Notes

### Goodhart Wiring Pattern

The wiring in `src/index.ts` should follow the existing initialization pattern (lazy, non-fatal):

```typescript
// After hounfour initialization (~line 313)
let goodhartConfig: MechanismConfig | undefined
try {
  const killSwitch = new KillSwitch(runtimeConfig)
  const transport = createDixieTransport(process.env.DIXIE_BASE_URL)
  const decay = redis ? new TemporalDecayEngine(redis) : undefined
  const exploration = redis ? new ExplorationEngine(redis) : undefined
  // ... compose into MechanismConfig
} catch (err) {
  console.warn("[finn] goodhart: initialization failed (non-fatal)")
}
```

### Gibson Environment Names (Reference)

| Letter | Name | Source |
|--------|------|--------|
| A | armitage | Neuromancer — Colonel Willis Armitage |
| B | bobby | Count Zero — Bobby Newmark |
| C | chiba | Neuromancer — Chiba City |
| D | dixieflat | Neuromancer — Dixie Flatline (McCoy Pauley) |
| E | edge | — |
| F | freeside | Neuromancer — Freeside orbital |
| G | gothick | Mona Lisa Overdrive |
| H | hosaka | Neuromancer — Hosaka corporation |
| I | ice | Neuromancer — Intrusion Countermeasures Electronics |
| J | julius | Neuromancer — Julius Deane |
| K | kumiko | Mona Lisa Overdrive — Kumiko Yanaka |
| L | linda | Neuromancer — Linda Lee |
| M | molly | Neuromancer — Molly Millions |
| N | neuromancer | Neuromancer — the AI |
| O | ono-sendai | Neuromancer — Ono-Sendai cyberspace deck |
| P | panther | Neuromancer — Panther Moderns |
| R | riviera | Neuromancer — Peter Riviera |
| S | straylight | Neuromancer — Villa Straylight |
| T | tessier | Neuromancer — Tessier-Ashpool S.A. |
| W | wintermute | Neuromancer — Wintermute AI |
| Z | zion | Neuromancer — Zion cluster |

First staging: `finn.armitage.arrakis.community`
