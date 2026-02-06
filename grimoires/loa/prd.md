# Product Requirements Document: loa-finn

> **Version**: 1.0.0
> **Date**: 2026-02-06
> **Author**: @janitooor
> **Status**: Draft
> **Grounding**: `grimoires/loa/context/research-minimal-pi.md`

---

## 1. Problem Statement

### The Problem

Running a persistent Loa agent requires infrastructure that currently only exists in loa-beauvoir — a 16,000+ line integration of the full OpenClaw platform. This creates three problems:

1. **Operational complexity**: OpenClaw includes WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Teams, Matrix, companion apps, browser control, and canvas rendering. For a web-accessible Loa agent, 90% of this surface area is dead weight that increases attack surface, deployment size (~2.5GB), and cognitive load.

2. **Integration fragility**: loa-beauvoir required three attempts (PRs #5, #9, core) to integrate Loa as the controlling identity — each approach fighting OpenClaw's lifecycle assumptions. Plugin sandboxing was too restrictive. Hook-based integration coupled to the host. Only direct core modification worked, but now Loa is surgically embedded in someone else's codebase.

3. **Compound learning requires persistence**: The compound effect philosophy — where patterns discovered on Day N inform Day N+1's work — requires a runtime that is always available, crash-resilient, and capable of maintaining state across restarts and deployments. Without reliable persistence, the learning loop breaks.

> **Source**: research-minimal-pi.md §1-2, compound-effect-philosophy.md, loa-beauvoir PRs #1-#20

### Why Now

- loa-beauvoir proved the concept works but revealed the cost of the "fork the cathedral" approach
- Pi's SDK layer (`@mariozechner/pi-coding-agent`) provides the exact agent primitives needed without the OpenClaw overhead
- The beads-first architecture (Loa v1.29.0) provides a universal state machine that loa-finn can build on from day one, rather than migrating to after 20 PRs

### Vision

**A persistent Loa agent accessible via web, built from first principles with Pi's SDK layer, where consistency, reliability, and persistence are the foundation — not features added later.**

The analogy: loa-finn is to loa-beauvoir what k3s is to Kubernetes. Same agent capabilities. ~1,400 lines of custom code vs 16,480+. ~500MB image vs ~2.5GB.

---

## 2. Goals & Success Metrics

### Primary Goals

| ID | Goal | Priority |
|----|------|----------|
| G-1 | Persistent Loa agent accessible via web browser | P0 |
| G-2 | State survives process restarts and deployments | P0 |
| G-3 | Compound learning cycle operational (learn → apply → verify) | P0 |
| G-4 | Self-healing recovery without human intervention | P1 |
| G-5 | Deployable to Cloudflare Workers (or similar) | P1 |
| G-6 | Non-technical team members can access via web UI | P2 |
| G-7 | Multi-tenant expansion (isolated accounts per user) | P2 (future) |

### Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Boot-to-ready time | <15s | Time from process start to first message capability |
| Image size | <500MB | Docker image size |
| Max data loss on crash | <30s | WAL sync interval |
| Recovery time | <30s | Time from crash to full functionality |
| Custom code lines | <2,000 | Total non-dependency TypeScript |
| Uptime | 95% | Best-effort, fast recovery over redundancy |
| Compound cycle completion | 100% | Every cycle extracts and applies learnings |

### Non-Goals (Explicit)

- Multi-channel messaging (WhatsApp, Telegram, Discord, etc.)
- Companion apps (macOS, iOS, Android)
- Browser control (CDP) or canvas rendering
- Ed25519 manifest signing or PII redaction
- Multi-agent session messaging
- Horizontal scaling / multi-instance

> **Source**: research-minimal-pi.md §7 "What We Don't Need"

---

## 3. User & Stakeholder Context

### Primary Persona: The Operator

**Name**: Jani (Operator / Admin)
**Role**: Loa framework maintainer, deploys and manages the agent
**Needs**: Deploy once, run forever. Agent maintains its own state, applies compound learnings, creates PRs autonomously. Minimal ops burden.
**Pain points**: loa-beauvoir's complexity. Having to understand OpenClaw internals to debug agent issues.

### Secondary Persona: The Teammate

**Name**: Non-technical team member
**Role**: Interacts with the Loa agent via web chat
**Needs**: Open a URL, type a message, get a response. No setup, no authentication complexity.
**Pain points**: Can't use CLI-based agents. Needs browser-accessible interface.

### Future Persona: The Self-Hoster

**Name**: External developer
**Role**: Deploys their own loa-finn instance
**Needs**: `git clone`, configure API key, deploy. Clear docs, minimal configuration.
**Timeline**: Post-v1, when multi-tenant is added.

### Stakeholder Map

| Stakeholder | Interest | Influence |
|-------------|----------|-----------|
| @janitooor | Primary maintainer, architect | High |
| 0xHoneyJar team | End users via web UI | Medium |
| Loa community | Self-hosting potential | Low (future) |

---

## 4. Functional Requirements

### FR-1: Agent Core (P0)

The system MUST embed Pi's SDK to run a Loa-controlled coding agent.

| ID | Requirement | Acceptance Criteria |
|----|-------------|-------------------|
| FR-1.1 | Initialize Pi agent session via `createAgentSession()` | Agent boots and accepts a message |
| FR-1.2 | Load Loa identity from BEAUVOIR.md as system prompt | System prompt contains Loa personality and directives |
| FR-1.3 | Register Loa tools (read, write, edit, bash) + Pi builtins | All registered tools are callable by the agent |
| FR-1.4 | Support streaming responses | Tokens stream to client as generated |
| FR-1.5 | Handle context window exhaustion via auto-compaction | Agent continues working after compaction. Compaction invariants preserved: system prompt, tool policies, current task state, key learnings. Compaction report stored in WAL with before/after token counts and preserved context summary |

> **Grounding**: research-minimal-pi.md §3 (Pi SDK), §4 (Minimal Architecture)

### FR-2: Gateway (P0)

The system MUST provide a web-accessible interface for interacting with the agent.

| ID | Requirement | Acceptance Criteria |
|----|-------------|-------------------|
| FR-2.1 | HTTP server with `/health` endpoint | Returns 200 with status JSON |
| FR-2.2 | WebSocket endpoint for streaming chat | Client connects, sends message, receives streaming response |
| FR-2.3 | Session management (create, resume, list) | Sessions persist across page reloads |
| FR-2.4 | Static WebChat UI served from gateway | Browser opens URL, renders chat interface |
| FR-2.5 | REST API for non-streaming interactions | POST /api/message returns complete response |
| FR-2.6 | Session concurrency control | Single-writer enforcement per session; one active WebSocket per session (new connection evicts old with reason code); message queueing with deterministic ordering guaranteed |

### FR-3: Persistence (P0)

The system MUST maintain state across process restarts and deployments.

| ID | Requirement | Acceptance Criteria |
|----|-------------|-------------------|
| FR-3.1 | Write-ahead log (WAL) for all state mutations | Every mutation logged before application |
| FR-3.2 | WAL uses flock-based exclusive writes | No TOCTOU race conditions |
| FR-3.3 | Object store sync every 30s (R2/S3) | Data replicates to warm storage |
| FR-3.4 | Git sync every 1h | State committed for audit trail |
| FR-3.5 | Recovery cascade on boot: Object Store → Git → Template with three recovery modes | **strict**: fail fast on WAL corruption (data integrity over availability). **degraded**: read-only mode when state is suspect (serve history, reject mutations). **clean**: template start when no recoverable state exists. Recovery mode selection and outcome logged prominently in WAL and exposed via `/health` |
| FR-3.6 | Pi session files (JSONL) included in persistence | Conversation history survives restart |

> **Grounding**: research-minimal-pi.md §5 (Persistence-First Design), loa-beauvoir PRs #1, #5, #16

### FR-4: Beads State Machine (P0)

The system MUST use beads (`br` CLI) as the universal state machine.

| ID | Requirement | Acceptance Criteria |
|----|-------------|-------------------|
| FR-4.1 | All runtime state tracked via beads labels | No `.run/` JSON files for state |
| FR-4.2 | Labels: `session:active`, `health:ok`, `sync:pending`, `circuit-breaker:{id}` | Labels queryable via `br list --label` |
| FR-4.3 | Bead state transitions logged to WAL | State changes are recoverable |
| FR-4.4 | Stale bead detection (24h) | Orphaned beads are flagged |

> **Grounding**: research-minimal-pi.md §5 (Beads as Universal State Machine), loa-beauvoir PRs #16-#17

### FR-5: Scheduler & Health (P1)

The system MUST self-monitor and self-heal.

| ID | Requirement | Acceptance Criteria |
|----|-------------|-------------------|
| FR-5.1 | Scheduler with configurable tasks | Tasks registered with interval and handler |
| FR-5.2 | Circuit breakers on all scheduled tasks | 3 failures → 5min cooldown → half-open retry |
| FR-5.3 | Health check aggregation | `/health` shows beads + WAL + sync + agent status |
| FR-5.4 | R2 sync task (30s interval) | Warm backup maintained |
| FR-5.5 | Git sync task (1h interval) | Cold backup maintained |
| FR-5.6 | Stale bead detection task (24h interval) | Orphaned state flagged |

> **Grounding**: research-minimal-pi.md §4 (Component Inventory), loa-beauvoir PR #6

### FR-6: Compound Learning Integration (P0)

The system MUST support the compound learning cycle as a core capability.

| ID | Requirement | Acceptance Criteria |
|----|-------------|-------------------|
| FR-6.1 | BEAUVOIR.md auto-reload on file change | Agent picks up identity changes without restart |
| FR-6.2 | Grimoire state (`grimoires/loa/`) persisted through sync | NOTES.md, skills, learnings survive restart |
| FR-6.3 | Trajectory logging to JSONL | All agent actions logged for batch retrospective |
| FR-6.4 | Compound review trigger (end-of-cycle or scheduled) | `/compound` extracts learnings from trajectory |
| FR-6.5 | Learnings applied to next session's context | Agent gets smarter each cycle |
| FR-6.6 | Beads work queue for bounded sessions | Tasks decomposed into 30-min bounded units |

> **Grounding**: compound-effect-philosophy.md, cycle-based-compounding.md, ryan-carson-pattern.md, loa-beauvoir PR #20

### FR-7: Deployment (P1)

The system MUST be deployable to a web-accessible environment.

| ID | Requirement | Acceptance Criteria |
|----|-------------|-------------------|
| FR-7.1 | Dockerfile producing <500MB image | Image builds successfully under target |
| FR-7.2 | Cloudflare Workers container config | `wrangler.jsonc` deploys successfully |
| FR-7.3 | GitHub Actions CI/CD pipeline | Push to main triggers build + deploy |
| FR-7.4 | Smoke test with automatic rollback | Failed deploy reverts to previous version |
| FR-7.5 | Cron triggers for sync tasks | Cloudflare cron or internal scheduler handles periodic work |
| FR-7.6 | Environment variable configuration | API keys, storage credentials via env vars |

> **Grounding**: research-minimal-pi.md §6 (Deployment Strategy)

### FR-8: Authentication & Access Control (P0)

The system MUST enforce application-layer authentication on all interfaces. Single-tenant does not mean unauthenticated — the internet is multi-tenant by default.

| ID | Requirement | Acceptance Criteria |
|----|-------------|-------------------|
| FR-8.1 | Shared secret/token authentication on all API endpoints | Unauthenticated requests receive 401; valid token grants access |
| FR-8.2 | WebSocket connection authentication | WS upgrade rejected without valid token; mid-session token rotation supported |
| FR-8.3 | CORS origin validation and CSRF protection | Only allowlisted origins accepted; state-changing requests require CSRF token |
| FR-8.4 | Per-IP and per-session rate limiting | Excessive requests throttled (429); configurable limits per endpoint class |
| FR-8.5 | Tool permission model | Bash denied by default in production; command allowlist enforced; tool invocations logged |

> **Grounding**: Flatline Protocol consensus (scored 945-980 across all reviews). Single-tenant ≠ unauthenticated.

---

## 5. Technical Requirements & Constraints

### Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Node.js 22+ | Pi SDK requirement |
| Language | TypeScript (strict mode) | Pi SDK, type safety |
| Package manager | pnpm | Workspace-aware, fast, disk-efficient |
| Agent SDK | `@mariozechner/pi-coding-agent` v0.51.x | Minimal agent primitives |
| HTTP framework | Hono | Lightweight, Cloudflare Workers native |
| Deployment | Cloudflare Workers Containers | Proven in loa-beauvoir, R2 included |
| State management | beads_rust (`br` CLI) | Loa v1.29.0 beads-first architecture |
| Object storage | Cloudflare R2 (S3-compatible) | Free with Workers, persistence tier 2 |

### Non-Functional Requirements

| ID | Category | Requirement | Target |
|----|----------|-------------|--------|
| NFR-1 | Performance | Boot-to-ready | <15s |
| NFR-2 | Performance | Message response start (streaming) | <2s |
| NFR-3 | Reliability | Max data loss on crash | <30s (WAL sync) |
| NFR-4 | Reliability | Recovery time after crash | <30s |
| NFR-5 | Reliability | Uptime | 95% (best-effort) |
| NFR-6 | Size | Docker image | <500MB |
| NFR-7 | Size | Custom code | <2,000 lines |
| NFR-8 | Security | API key storage | Environment variables only, never in code |
| NFR-9 | Security | No secrets in git | .env excluded, R2 credentials via Workers secrets |
| NFR-10 | Operability | Single-command local dev | `pnpm dev` boots everything |
| NFR-11 | Operability | Zero-config deployment | Push to main = deployed |
| NFR-12 | Security | Tool execution sandboxing | Bash commands run in restricted workspace directory; filesystem scoped to project root; no env var access to secrets from tool context; egress controls limit network access to allowlisted hosts |

### Constraints

1. **Pi SDK compatibility**: Must use Pi's session format (JSONL with tree structure) without modification
2. **Cloudflare Workers limits**: Container instances are single-process; no multi-threading
3. **R2 eventual consistency**: Object store syncs may lag; WAL is source of truth
4. **Single-tenant v1**: Authentication required (FR-8), but no user isolation (multi-tenant added in v1.1)
5. **Cloudflare Workers container capabilities**: Must validate CF Workers container capabilities (durable volumes, flock behavior, binary exec, disk limits) before Sprint 3. Fly.io fallback if not validated.

---

## 6. Scope & Prioritization

### MVP (v1.0) — What Ships

| Feature | Sprint | Priority |
|---------|--------|----------|
| Pi SDK agent with Loa identity | 1 | P0 |
| WebChat gateway (HTTP + WS) | 2 | P0 |
| Authentication & access control (FR-8) | 2 | P0 |
| 3-tier persistence (WAL → R2 → Git) | 3 | P0 |
| Beads state machine | 3 | P0 |
| Scheduler + circuit breakers + health | 4 | P1 |
| Compound learning integration | 4 | P0 |
| Cloudflare Workers deployment | 5 | P1 |
| Loa tool registration + BEAUVOIR.md reload | 6 | P0 |
| Bounded work queue (30-min sessions) | 6 | P1 |

### v1.1 — Follow-up Cycle

| Feature | Description |
|---------|-------------|
| Multi-tenant | Isolated accounts per user, basic auth |
| Messaging channels | Discord/Slack as gateway plugins |
| Monitoring dashboard | Grafana/Prometheus or CF analytics |
| Horizontal scaling | Multiple container instances |

### Explicitly Out of Scope (v1.0)

- WhatsApp, Telegram, Signal, iMessage, Teams, Matrix
- Companion apps (macOS, iOS, Android)
- Browser control (CDP), Canvas (A2UI)
- Ed25519 manifest signing, PII redaction
- Multi-agent session messaging
- User isolation / multi-tenant (single-tenant with shared-secret auth in v1)

> **Source**: research-minimal-pi.md §7 "What We Don't Need"

---

## 7. Risks & Dependencies

### Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Pi SDK API instability | Medium | High | Pin to v0.51.x, vendor if needed |
| Pi session format changes | Medium | Medium | Adapter layer wraps session access |
| Cloudflare Workers container limits | Low | High | Fly.io fallback deployment target |
| Context window exhaustion | High | Medium | Pi's built-in auto-compaction + Loa protocols |
| Single point of failure (1 instance) | Medium | Medium | WAL + 30s sync = max 30s data loss |
| Pi licensing changes | Low | High | MIT licensed, can vendor entire SDK |

### External Dependencies

| Dependency | Type | Risk Level |
|------------|------|-----------|
| `@mariozechner/pi-coding-agent` v0.51.x | npm package | Medium (pin version) |
| `@mariozechner/pi-ai` v0.51.x | npm package | Medium (pin version) |
| `@mariozechner/pi-agent-core` v0.51.x | npm package | Medium (pin version) |
| Anthropic API (Claude) | External API | Low (mature, redundant) |
| Cloudflare Workers + R2 | Infrastructure | Low (enterprise-grade) |
| beads_rust (`br` CLI) | Binary tool | Low (vendorable, audited) |

### Business Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Scope creep toward full OpenClaw | Medium | High | PRD explicitly lists non-goals |
| Team adoption friction | Low | Medium | WebChat UI reduces barrier |
| Maintenance burden | Low | Low | ~1,400 lines custom code |

---

## 8. Implementation Roadmap

### Sprint Overview

| Sprint | Name | Goal | Depends On |
|--------|------|------|-----------|
| 1 | Agent Core | Pi SDK boots, accepts message, returns response | — |
| 2 | Gateway + Auth | WebChat accessible via browser with authentication (FR-8) | Sprint 1 |
| 3 | Persistence | State survives restart | Sprint 1 |
| 4 | Scheduler & Compound | Self-monitoring + compound learning cycle | Sprint 3 |
| 5 | Deployment | Running on the internet | Sprint 2, 3 |
| 6 | Loa Integration | Full agent capabilities + work queue | Sprint 4, 5 |

### Sprint Dependency Graph

```
Sprint 1 (Agent Core)
├──► Sprint 2 (Gateway + Auth)
│    └──► Sprint 5 (Deployment)
└──► Sprint 3 (Persistence)
     └──► Sprint 4 (Scheduler & Compound)
          └──► Sprint 6 (Loa Integration)
```

### Exit Criteria per Sprint

| Sprint | Exit Criteria |
|--------|--------------|
| 1 | `node dist/smoke.js "Hello"` returns coherent Claude response via Pi SDK |
| 2 | Browser opens URL, authenticates with shared secret, types message, sees streaming response. Unauthenticated requests rejected with 401. |
| 3 | Kill process → restart → resume conversation where left off |
| 4 | `/health` returns status. Circuit breakers trigger on failure. Compound review runs. |
| 5 | Push to main → deployed → accessible via URL → survives rollback |
| 6 | Loa agent accessible via web, runs autonomously, state persists, compound learning operational |

---

## Appendix A: Decision Log

| ID | Decision | Rationale | Date |
|----|----------|-----------|------|
| D-001 | Use Pi SDK, not fork OpenClaw | Minimal surface area, same agent primitives | 2026-02-06 |
| D-002 | WebChat only, no messaging channels | Smallest useful surface; channels are additive | 2026-02-06 |
| D-003 | Beads as universal state machine | Follow loa-beauvoir's trajectory (PRs 16-20) | 2026-02-06 |
| D-004 | WAL → Object Store → Git persistence | Proven 3-tier pattern from loa-beauvoir | 2026-02-06 |
| D-005 | Cloudflare Workers primary target | Leverage existing loa-beauvoir deployment knowledge | 2026-02-06 |
| D-006 | TypeScript, pnpm, Node 22+ | Match Pi SDK runtime requirements | 2026-02-06 |
| D-007 | No SOUL.md transformation | Direct BEAUVOIR.md → system prompt, skip indirection | 2026-02-06 |
| D-008 | Circuit breakers on all scheduled tasks | Proven pattern from loa-beauvoir (PR #16) | 2026-02-06 |
| D-009 | Single-tenant v1 with shared-secret auth, multi-tenant v1.1 | Ship fast with auth from day one; the internet is multi-tenant by default | 2026-02-06 |
| D-010 | Compound learning as core, not addon | Persistence enables compounding; compounding justifies persistence | 2026-02-06 |
| D-011 | Hono for HTTP framework | Lightweight, CF Workers native, 14KB | 2026-02-06 |
| D-012 | Best-effort uptime (95%), fast recovery | Invest in recovery speed over redundancy | 2026-02-06 |

## Appendix B: Glossary

| Term | Definition |
|------|-----------|
| **Pi** | Mario Zechner's minimal agent toolkit (badlogic/pi-mono) |
| **OpenClaw** | Full-featured AI assistant platform that embeds Pi |
| **loa-beauvoir** | Previous Loa cloud deployment using full OpenClaw |
| **loa-finn** | This project: minimal Loa agent runtime using Pi SDK only |
| **BEAUVOIR.md** | Agent identity/personality definition file |
| **WAL** | Write-ahead log for crash-safe state mutations |
| **Beads** | Task/state tracking system via beads_rust (`br` CLI) |
| **Compound learning** | Cross-session pattern extraction and application |
| **Circuit breaker** | Fault tolerance pattern: failures → cooldown → half-open retry |
