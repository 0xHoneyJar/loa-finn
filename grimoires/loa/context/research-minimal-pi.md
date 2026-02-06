# Research: Minimal Pi Architecture for loa-finn

> **Status**: Research / RFC
> **Author**: @janitooor
> **Date**: 2026-02-06
> **Related**: [loa-beauvoir](https://github.com/0xHoneyJar/loa-beauvoir) | [loa](https://github.com/0xHoneyJar/loa) | [OpenClaw](https://github.com/openclaw/openclaw) | [pi-mono](https://github.com/badlogic/pi-mono)

---

## Executive Summary

This document maps out the architectural approach for building **loa-finn**: a minimal, persistent Loa agent runtime built from first principles using [Pi](https://github.com/badlogic/pi-mono)'s SDK layer.

Where loa-beauvoir took the "fork the cathedral" approach — importing all of OpenClaw's 145k+ star codebase and grafting Loa identity on top — loa-finn takes the opposite path: **start with nothing, add only what's load-bearing**.

The philosophy draws from Rich Hickey's "Simple Made Easy" talk: *complecting* runtime infrastructure with messaging surfaces and companion apps creates a system where changing anything requires understanding everything. loa-finn decomplects by building up from Pi's minimal agent primitives.

---

## Table of Contents

1. [Why loa-finn Exists](#1-why-loa-finn-exists)
2. [What loa-beauvoir Taught Us](#2-what-loa-beauvoir-taught-us)
3. [Pi: The Right Abstraction Layer](#3-pi-the-right-abstraction-layer)
4. [Minimal Architecture](#4-minimal-architecture)
5. [Persistence-First Design](#5-persistence-first-design)
6. [Deployment Strategy](#6-deployment-strategy)
7. [What We Don't Need](#7-what-we-dont-need)
8. [Implementation Roadmap](#8-implementation-roadmap)
9. [Risk Analysis](#9-risk-analysis)
10. [Decision Log](#10-decision-log)

---

## 1. Why loa-finn Exists

### The Problem

loa-beauvoir works. It runs a Loa-controlled agent on Cloudflare Workers with 3-tier persistence, self-healing recovery, and multi-channel messaging. But it carries the weight of an entire OpenClaw installation — a codebase designed for *general-purpose personal AI assistant* use cases with WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Microsoft Teams, Matrix, companion apps, browser control, canvas rendering, and more.

For our use case — **a persistent Loa agent accessible via web** — this is like shipping a container ship to cross a river.

### The Insight

The Kubernetes project learned this lesson when they created [k3s](https://k3s.io/). Rancher didn't fork Kubernetes and strip features — they identified the *kernel* of what makes Kubernetes work (the control loop, etcd, kubelet) and rebuilt a distribution around just those primitives. k3s is a fully conformant Kubernetes distribution in a single 70MB binary.

**loa-finn is our k3s moment.** Same Loa agent identity and capabilities. Fraction of the infrastructure.

### The Name

In William Gibson's *Count Zero*, **Finn** is the fence and fixer who operates from a tiny, cluttered shop but knows where every piece of black-market tech comes from and how to make it work. Where Beauvoir channels the Loa through elaborate ceremony, Finn gets things done with minimal apparatus and deep knowledge.

---

## 2. What loa-beauvoir Taught Us

### Architecture (4 Layers)

loa-beauvoir established a clean separation:

| Layer | Component | What It Does |
|-------|-----------|-------------|
| L0 | Loa Framework (`.claude/`) | Agent identity, skills, protocols |
| L1 | Devcontainer Runtime | Container baseline with Claude Code |
| L2 | Moltworker Infrastructure | Cloudflare Workers container orchestration |
| L3 | Loa Identity (`deploy/`) | Custom boot, persistence, scheduling |

**Key learning**: L0 and L3 are the only layers that matter for our use case. L1 and L2 are infrastructure conveniences that can be replaced with simpler alternatives.

### The Three Integration Attempts

loa-beauvoir's history of integrating Loa into OpenClaw is instructive:

| Attempt | Approach | Outcome | Lesson |
|---------|----------|---------|--------|
| PR #5 | Plugin in `extensions/loa/` | Failed | Extensions are too sandboxed for identity-level control |
| PR #9 | Plugin with hook registration | Merged but superseded | Hook-based integration creates coupling to the host's lifecycle |
| PR (current) | Direct core integration in `src/agents/` | Works | When you need deep control, you need to own the agent loop |

This mirrors the evolution of service meshes in cloud-native. Linkerd v1 tried the sidecar-proxy approach (analogous to plugins). Istio tried the control-plane approach (analogous to hooks). Both eventually converged on **kernel-level integration** (eBPF in Cilium) because the closer you are to the primitive, the less impedance mismatch you fight.

**For loa-finn**: We don't graft Loa onto someone else's agent. We build the agent loop with Loa as the native identity from the start.

### Persistence Patterns (What to Keep)

loa-beauvoir's persistence architecture is genuinely excellent and should be preserved:

```
Write Event → WAL (immediate, flock-based)
                  ↓ (30s)
              R2/S3 Sync (warm backup)
                  ↓ (1h)
              Git Commit (cold backup, auditable)
```

- **Segmented WAL** with 10MB rotation and two-phase commits
- **Circuit breakers** on all scheduled tasks (3 failures → 5min cooldown → half-open retry)
- **Self-healing recovery cascade**: R2 → Git → Template (never stops, never waits for human)
- **Beads as state source of truth** (PR #17): run-mode labels replace fragile JSON files

### What PRs 16-20 Revealed

The most recent PRs tell the story of where loa-beauvoir was heading:

- **PR #16** (Beads persistence layer): WAL integration for bead state transitions, scheduled health/sync/stale checks
- **PR #17** (BeadsRunStateManager): `.run/` JSON files → beads labels (`run:current`, `sprint:in_progress`, `circuit-breaker`)
- **PR #18** (Upstream dedup): 713 lines eliminated by importing Loa's beads security utilities
- **PR #19** (Deferred tool loading): Background `beads_rust` installation, pinned to audited commit
- **PR #20** (Work queue, OPEN): Cron-based task decomposition with 30-minute bounded sessions

The trajectory is clear: **beads become the universal state machine**, replacing ad-hoc JSON, WAL entries, and scheduler state. loa-finn should start here, not arrive here after 20 PRs.

---

## 3. Pi: The Right Abstraction Layer

### What Pi Is

Pi ([badlogic/pi-mono](https://github.com/badlogic/pi-mono)) is Mario Zechner's minimal agent toolkit. OpenClaw embeds it via SDK mode. Pi provides exactly the primitives we need:

| Package | npm | What It Does |
|---------|-----|-------------|
| `pi-ai` | `@mariozechner/pi-ai` | Multi-provider LLM API (streaming, tool calling, token tracking) |
| `pi-agent-core` | `@mariozechner/pi-agent-core` | Agent loop (LLM call → tool exec → repeat), state, events |
| `pi-coding-agent` | `@mariozechner/pi-coding-agent` | `createAgentSession()`, SessionManager, AuthStorage, built-in tools |

### What We Take

Pi's SDK mode gives us exactly what we need and nothing we don't:

```typescript
import { createAgentSession } from "@mariozechner/pi-coding-agent"

const session = await createAgentSession({
  model: { provider: "anthropic", model: "claude-opus-4-6" },
  systemPrompt: loaSystemPrompt,     // Built from BEAUVOIR.md + Loa identity
  tools: [...loaTools, ...piBuiltins], // Loa tools + read/write/edit/bash
  sessionDir: "/data/sessions",        // JSONL persistence
})
```

This is analogous to how SQLite succeeded against MySQL/PostgreSQL for embedded use cases. SQLite didn't implement a client-server protocol, connection pooling, or multi-user access control — it implemented *the SQL engine* and exposed it as a library call. Pi's SDK mode is the SQLite of agent runtimes.

### What We Skip

| Pi Component | Purpose | loa-finn? |
|-------------|---------|-----------|
| `pi-tui` | Terminal UI rendering | No — we have webchat |
| `pi-web-ui` | Web components for chat | Maybe — evaluate vs custom |
| `pi-mom` | Slack bot | No — Loa handles channels |
| `pi-pods` | GPU pod management | No |
| Extensions/Skills/Themes | Extensibility | No — Loa has its own |
| RPC mode | Cross-language integration | No — SDK mode only |
| Interactive mode | Terminal TUI | No |
| Print/JSON mode | Single-shot CLI | No |

### The Four Modes of Pi

Pi runs in four modes. We use exactly one:

1. ~~**Interactive**~~ — Full TUI terminal experience
2. ~~**Print/JSON**~~ — Single-shot, output and exit
3. ~~**RPC**~~ — JSON-RPC over stdin/stdout
4. **SDK** — Programmatic embedding via `createAgentSession()` ← **This one**

---

## 4. Minimal Architecture

### Layer Diagram

```
┌─────────────────────────────────────────────┐
│                   Web Client                 │
│              (WebSocket + REST)              │
└─────────────────┬───────────────────────────┘
                  │
┌─────────────────▼───────────────────────────┐
│              Gateway (thin)                  │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐ │
│  │ WebChat  │  │ REST API │  │ WebSocket │ │
│  └────┬─────┘  └────┬─────┘  └─────┬─────┘ │
│       └──────────────┼──────────────┘       │
│                      ▼                       │
│  ┌──────────────────────────────────────┐   │
│  │         Session Manager              │   │
│  │   (JSONL tree + in-memory cache)     │   │
│  └──────────────────┬───────────────────┘   │
│                     ▼                        │
│  ┌──────────────────────────────────────┐   │
│  │         Pi Agent Loop (SDK)          │   │
│  │  createAgentSession() + tool exec    │   │
│  └──────────────────┬───────────────────┘   │
│                     ▼                        │
│  ┌──────────────────────────────────────┐   │
│  │         Loa Identity Layer           │   │
│  │  BEAUVOIR.md → System Prompt         │   │
│  │  .claude/ skills + protocols         │   │
│  │  grimoires/ state + memory           │   │
│  └──────────────────────────────────────┘   │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │         Persistence Layer            │   │
│  │  WAL → Object Store → Git           │   │
│  │  Beads state machine                 │   │
│  │  Scheduler (health, sync, stale)     │   │
│  └──────────────────────────────────────┘   │
└──────────────────────────────────────────────┘
```

### Component Inventory

| Component | Source | Lines (est.) | Purpose |
|-----------|--------|-------------|---------|
| Pi SDK | npm packages | 0 (dependency) | Agent loop, LLM API, session management |
| Gateway | Custom | ~200 | HTTP/WS server, routing |
| Identity Loader | Custom | ~100 | BEAUVOIR.md → system prompt |
| Tool Registry | Custom | ~150 | Loa tools + Pi builtins |
| WAL | From loa-beauvoir | ~300 | Write-ahead log with flock |
| Storage Sync | Custom | ~200 | R2/S3 + Git sync |
| Scheduler | Custom | ~250 | Cron tasks with circuit breakers |
| Beads Bridge | Custom | ~150 | br CLI integration for state |
| Boot Script | Custom | ~50 | Container entry point |
| **Total custom** | | **~1,400** | |

Compare this to loa-beauvoir's 16,480+ lines in PR #1 alone.

### The "Elm Architecture" Principle

The architecture follows what the Elm community calls "The Elm Architecture" (TEA) — a unidirectional data flow that makes the system trivially debuggable:

```
User Message → Gateway → Agent Loop → Tool Execution → State Update → Response
                                            ↓
                                    WAL → Sync → Git
                                            ↓
                                    Beads State Machine
```

No bidirectional data flow. No event bus spaghetti. No callback hell. Every state transition is observable, logged, and recoverable.

---

## 5. Persistence-First Design

### Why Persistence Is the #1 Priority

A persistent agent that forgets is worse than no agent at all. The user explicitly prioritized **consistency, reliability, and persistence**. This is not a feature — it's the foundation.

Netflix's engineering team articulated this well in their [Zuul 2 architecture](https://netflixtechblog.com/): "The first thing we built was the health check. Not the proxy. Not the routing. The health check. Because a system that doesn't know it's broken is a system you can't trust."

### Beads as Universal State Machine

Following loa-beauvoir PR #17's direction, beads are the single source of truth:

```
┌─────────────────────────────────────┐
│           Beads State Machine       │
│                                     │
│  ┌─────────┐    ┌──────────────┐   │
│  │ pending │───▶│ in_progress  │   │
│  └─────────┘    └──────┬───────┘   │
│                        │            │
│                ┌───────▼────────┐   │
│                │   completed    │   │
│                └────────────────┘   │
│                                     │
│  Labels:                            │
│    run:current                      │
│    sprint:in_progress               │
│    session:active                   │
│    health:ok | health:degraded      │
│    sync:pending | sync:complete     │
│    circuit-breaker:{task_id}        │
│                                     │
└─────────────────────────────────────┘
```

**No `.run/` JSON files. No ad-hoc state. Beads or nothing.**

### WAL Design (Simplified)

loa-beauvoir's WAL had segmented rotation and two-phase commits. For loa-finn, we start simpler but keep the guarantees:

```typescript
interface WALEntry {
  id: string           // ULID (sortable, unique)
  timestamp: number    // Unix ms
  type: string         // "session" | "bead" | "memory" | "config"
  operation: string    // "create" | "update" | "delete"
  data: unknown        // The payload
  checksum: string     // SHA-256 of data
}
```

**Guarantees**:
- Every mutation is WAL'd before application
- flock-based exclusive writes (no TOCTOU)
- Append-only within segments
- Rotation at 10MB boundaries

### Sync Strategy

```
WAL (every write)
  ↓ (30s, circuit-breaked)
Object Store (R2/S3)
  ↓ (1h, circuit-breaked)
Git Commit (auditable)
```

The 30-second sync window means maximum 30 seconds of data loss in a catastrophic failure. For a coding agent, this is acceptable — you lose at most one tool execution result, which the agent can re-derive.

### Recovery Cascade

```
Boot / Crash Recovery:
  1. Try: Load from Object Store (warm, <5s)
  2. Fallback: Pull from Git (cold, <30s)
  3. Last resort: Initialize from template (clean start)

  NEVER: Stop and wait for human intervention
```

This follows the same principle as Erlang's "let it crash" philosophy. The BEAM VM doesn't try to prevent crashes — it ensures the system recovers faster than the user notices. Joe Armstrong called this "designing for failure rather than designing against failure."

---

## 6. Deployment Strategy

### Primary Target: Cloudflare Workers Containers

loa-beauvoir proved this works. We keep the deployment target but simplify the image:

| Component | loa-beauvoir | loa-finn |
|-----------|-------------|----------|
| Base image | `cloudflare/sandbox:0.7.0` | Same |
| Image size | ~2.5GB (core) + deferred tools | ~500MB target |
| Boot time | <30s + background tool install | <15s target |
| Node.js | v22+ | v22+ |
| Pi packages | Full OpenClaw + pi | Pi SDK packages only |
| Loa identity | `.claude/` mounted | `.claude/` mounted |
| Gateway | moltworker + clawdbot | Custom thin gateway |

### Alternative: Fly.io / Railway

For even simpler deployment, a standard Docker container on Fly.io or Railway could work:

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
CMD ["node", "dist/index.js"]
```

No Cloudflare-specific bindings. No wrangler. No R2. Just a process that runs.

The tradeoff: Cloudflare gives us edge compute + R2 + cron triggers for free. Fly/Railway gives us simpler ops but requires separate object storage (S3) and cron (external).

### Dev Environment

```bash
# Single command to run locally
pnpm dev

# Docker for parity with production
docker compose up
```

No `make dev`, no `entr` watchers, no three-tier dev workflow. One command. If it works locally, it works in prod.

---

## 7. What We Don't Need

This section is as important as the architecture. Every line of code we don't write is a line that can't break.

| Feature | In loa-beauvoir | In loa-finn | Why Not |
|---------|----------------|-------------|---------|
| WhatsApp gateway | Yes (Baileys) | No | Web-only for now |
| Telegram bot | Yes (grammY) | No | Web-only for now |
| Discord bot | Yes (discord.js) | No | Web-only for now |
| Slack integration | Yes (Bolt) | No | Web-only for now |
| Signal, iMessage, Teams, Matrix | Yes | No | Web-only for now |
| macOS companion app | Yes | No | Web-only |
| iOS/Android nodes | Yes | No | Web-only |
| Browser control (CDP) | Yes | No | Not needed for agent tasks |
| Canvas (A2UI) | Yes | No | Not needed |
| Ed25519 manifest signing | Yes | No | Overkill for single-tenant |
| PII redactor | Yes | No | Single-tenant, trusted context |
| Multi-agent session messaging | Yes | No | Single agent |
| SOUL.md generation | Yes | No | Direct system prompt from BEAUVOIR.md |
| Netinstall deferred loading | Yes | No | Install everything at build time |
| Three integration attempts | Yes (PRs 5,9,core) | No | Pi SDK from day one |

### The "Messaging Channel" Question

The most impactful thing we're cutting is multi-channel messaging. This deserves explicit rationale:

OpenClaw's primary value proposition is "one AI across all your chat apps." That's not our use case. Our use case is "a Loa agent that runs persistently and is accessible." WebChat (HTTP + WebSocket) is sufficient.

If messaging channels are needed later, they can be added as **plugins** to the gateway — one file per channel, no architectural changes. The gateway's internal API is channel-agnostic by design.

---

## 8. Implementation Roadmap

### Sprint 0: Foundation (This PR)

- [x] Research loa-beauvoir architecture and PRs
- [x] Research Pi/OpenClaw upstream
- [x] Document architectural decisions
- [x] Establish beads-first workflow

### Sprint 1: Agent Core

**Goal**: Pi SDK boots, accepts a message, returns a response.

| Task | Description | Beads Label |
|------|-------------|-------------|
| 1.1 | Initialize TypeScript project (pnpm, tsconfig, eslint) | `sprint:1` |
| 1.2 | Install Pi SDK packages (`pi-ai`, `pi-agent-core`, `pi-coding-agent`) | `sprint:1` |
| 1.3 | Create identity loader (BEAUVOIR.md → system prompt) | `sprint:1` |
| 1.4 | Create `createLoaSession()` wrapper around Pi's `createAgentSession()` | `sprint:1` |
| 1.5 | Write smoke test: send message, get response | `sprint:1` |

**Exit criteria**: `node dist/smoke.js "Hello"` returns a coherent response from Claude via Pi SDK.

### Sprint 2: Gateway

**Goal**: WebChat accessible via browser.

| Task | Description |
|------|-------------|
| 2.1 | HTTP server (Hono or native `http`) with health endpoint |
| 2.2 | WebSocket upgrade for streaming |
| 2.3 | Session routing (create/resume/list) |
| 2.4 | Static webchat UI (can borrow from `pi-web-ui` or build minimal) |

**Exit criteria**: Open browser, type message, see streaming response.

### Sprint 3: Persistence

**Goal**: Agent state survives restart.

| Task | Description |
|------|-------------|
| 3.1 | WAL implementation (append-only, flock, rotation) |
| 3.2 | Object store sync (R2 or S3 compatible) |
| 3.3 | Git sync (hourly commits) |
| 3.4 | Recovery cascade on boot |
| 3.5 | Beads state bridge (`br` CLI integration) |

**Exit criteria**: Kill process, restart, resume conversation where you left off.

### Sprint 4: Scheduler & Health

**Goal**: Self-monitoring, self-healing.

| Task | Description |
|------|-------------|
| 4.1 | Scheduler with circuit breakers |
| 4.2 | Health check endpoint (beads + WAL + sync status) |
| 4.3 | R2 sync task (30s) |
| 4.4 | Git sync task (1h) |
| 4.5 | Stale bead detection (24h) |

**Exit criteria**: `/health` returns comprehensive status. Circuit breakers trigger on simulated failure.

### Sprint 5: Deployment

**Goal**: Running on the internet.

| Task | Description |
|------|-------------|
| 5.1 | Dockerfile (minimal, <500MB target) |
| 5.2 | Cloudflare Workers config (wrangler.jsonc) |
| 5.3 | GitHub Actions CI/CD |
| 5.4 | Smoke test with rollback |
| 5.5 | Cron trigger for sync tasks |

**Exit criteria**: Push to main → deployed → accessible via URL → survives `wrangler rollback`.

### Sprint 6: Loa Integration

**Goal**: Full Loa agent capabilities.

| Task | Description |
|------|-------------|
| 6.1 | Loa tool registration (read, write, edit, bash + Loa-specific) |
| 6.2 | BEAUVOIR.md auto-reload on change |
| 6.3 | Grimoire state persistence |
| 6.4 | Session continuity across context compaction |
| 6.5 | Beads work queue (bounded 30-min sessions from PR #20 concept) |

**Exit criteria**: Loa agent accessible via web, runs autonomously, state persists across restarts and deploys.

---

## 9. Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Pi SDK API instability | Medium | High | Pin to specific version, vendor if needed |
| Cloudflare Workers container limits | Low | High | Alternative: Fly.io fallback |
| Pi session format changes | Medium | Medium | Wrap in adapter layer |
| Context window exhaustion | High | Medium | Pi's built-in auto-compaction + Loa protocols |
| Single point of failure (1 instance) | Medium | Medium | WAL + sync means <30s data loss on crash |
| Pi licensing changes | Low | High | MIT licensed, can vendor |

---

## 10. Decision Log

| ID | Decision | Rationale | Date |
|----|----------|-----------|------|
| D-001 | Use Pi SDK, not fork OpenClaw | Minimal surface area, same agent primitives | 2026-02-06 |
| D-002 | WebChat only, no messaging channels | Smallest useful surface; channels are additive | 2026-02-06 |
| D-003 | Beads as universal state machine | Follow loa-beauvoir's trajectory (PRs 16-20) | 2026-02-06 |
| D-004 | WAL + Object Store + Git persistence | Proven 3-tier pattern from loa-beauvoir | 2026-02-06 |
| D-005 | Cloudflare Workers primary, Fly.io fallback | Leverage existing loa-beauvoir deployment knowledge | 2026-02-06 |
| D-006 | TypeScript, pnpm, Node 22+ | Match Pi SDK runtime requirements | 2026-02-06 |
| D-007 | No SOUL.md transformation | Direct BEAUVOIR.md → system prompt, skip indirection | 2026-02-06 |
| D-008 | Circuit breakers on all scheduled tasks | Proven pattern from loa-beauvoir (PR #16) | 2026-02-06 |

---

## Appendix A: loa-beauvoir PR Summary

| PR | Title | Key Contribution |
|----|-------|-----------------|
| #1 | Loa Cloud Stack (5 sprints) | Foundation: upstream subtrees, Docker, WAL, R2/Git sync |
| #5 | Beauvoir resilience system | Ed25519 signing, PII redactor, segmented WAL, self-repair |
| #6 | Operational hardening (FR-6 to FR-11) | Timeout enforcer, bloat auditor, notification sink, health checks |
| #7 | Rapid Docker dev workflow | 3-tier dev: local Docker, GitHub Actions, CF Workers |
| #8 | Development workflow guide | Docs + graceful optional dependency handling |
| #9 | LOA-OpenClaw plugin integration | SOUL.md generation, memory capture, context injection, loop detector |
| #10 | Loa framework update to v1.27.0 | Configurable grimoire paths |
| #11 | Configurable BEAUVOIR.md path | `LOA_SOUL_SOURCE` env var |
| #14 | Minimal Docker image (netinstall) | ~2.5GB core + deferred tool loading |
| #15 | ACIP prompt injection defenses | Trust boundaries, injection patterns, action verification |
| #16 | Beads + OpenClaw persistence | WAL integration, scheduled tasks, crash recovery |
| #17 | BeadsRunStateManager | `.run/` → beads labels as state source of truth |
| #18 | Upstream dedup | -713 lines via Loa beads library imports |
| #19 | Deferred tool loading (dev) | Background beads_rust install, pinned to audited commit |
| #20 | Work queue (OPEN) | Cron-based task decomposition, 30-min bounded sessions |

## Appendix B: Pi Package Dependency Tree

```
@mariozechner/pi-coding-agent (SDK entry point)
├── @mariozechner/pi-agent-core (agent loop)
│   └── @mariozechner/pi-ai (LLM abstraction)
├── @mariozechner/pi-ai (direct dep too)
└── Built-in tools: read, write, edit, bash
```

**Estimated npm install footprint**: ~15MB (vs OpenClaw's full `node_modules` at 200MB+)

## Appendix C: Key File Locations

```
loa-finn/
├── .claude/              # Loa System Zone (read-only, from upstream)
├── grimoires/loa/        # Loa State Zone (read-write)
│   ├── BEAUVOIR.md       # Agent identity
│   ├── NOTES.md          # Working memory
│   └── context/          # Research & context docs
├── .beads/               # Beads state
├── src/                  # Application code
│   ├── index.ts          # Entry point
│   ├── gateway/          # HTTP/WS server
│   ├── agent/            # Pi SDK wrapper + identity loader
│   ├── persistence/      # WAL, sync, recovery
│   └── scheduler/        # Cron tasks + circuit breakers
├── deploy/               # Dockerfile, wrangler.jsonc, start.sh
└── package.json
```
