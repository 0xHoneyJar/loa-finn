# loa-finn

<!-- AGENT-CONTEXT: loa-finn is the home of the Finn experiment program — a research program
that runs pre-registered, sha-pinned experiments on the agentic economy (real commerce vs theater)
and the runtime that rides them. Two halves: (1) the experiment program — EXP-001 cost-of-play,
EXP-002 agent-commerce forensics, EXP-003 verify-the-void, EXP-004 graduation gate — recorded on a
research spine (observatory/), with a hash-chained cost meter (src/cost/cost-atom.ts) and a
deterministic, no-LLM Score core (src/score/); (2) the agent runtime it rides on — multi-model
routing (src/hounfour/), durable WAL persistence (src/persistence/), cron + sandbox + audit trail.
Epistemology: claims enter `claimed`; only deterministic instruments vs sha-pinned bars `settle`;
abstain over fabricate (grimoires/loa/context/epistemology-deterministic-layers.md). License: AGPL-3.0. -->

[![License](https://img.shields.io/badge/license-AGPL--3.0-green.svg)](LICENSE.md)
[![Runtime](https://img.shields.io/badge/runtime-Node%2022%2B-blue.svg)](package.json)
[![Ridden with](https://img.shields.io/badge/ridden%20with-Loa-purple.svg)](https://github.com/0xHoneyJar/loa)

> **What a thing is worth, and whether it's real** — the Finn's whole job in Gibson's Sprawl, and this program's.

## What is this?

**loa-finn is the home of the Finn experiment program — and the runtime that rides it.**

The program asks one question of the agentic economy, over and over, with instruments instead of opinions: **is this real, or is it theater?** Each answer is a pre-registered, sha-pinned experiment — bars set *before* the data exists, an instrumented run, a readout that has to survive its own falsifications. The answers accrete on a public **research spine** ([`observatory/`](observatory/)), where every dot traces to a committed artifact.

Underneath sits the runtime that makes the experiments cheap and durable: multi-model routing, a write-ahead log, a cron system, a tool sandbox, and a hash-chained cost meter that closes the bill before the response returns. The program is the soul; the runtime is the body it rides.

## Why "Finn"?

In William Gibson's Sprawl trilogy, **the Finn** is a fence — a Lower East Side dealer in hardware and information who knows what a thing is worth and whether it's counterfeit. By *Mona Lisa Overdrive* he's gone: persisted as an AI construct his friends still consult, a voice in a machine that appraises the real from the fake. He's the obvious patron for this work. The whole experiment program is the Finn's eye turned on the agent economy — **tell real commerce from registration theater, and price it honestly.** (Loa itself is named from the same Sprawl: AI entities that *ride* you through the interface. See [the Loa framework](https://github.com/0xHoneyJar/loa#why-loa).)

## The experiment program

Every experiment follows the same discipline: **register** the bars (pinned before data), **probe** (instrumented run), **settle** (a verdict from a deterministic instrument — `HELD` / `FALSIFIED` / `INSUFFICIENT` — never from an LLM). A falsification is progress.

| # | Experiment | Question | Settled |
|---|---|---|---|
| **EXP-001** | cost-of-play | Where does a per-call dollar go — infra or inference? | **H1/H2 FALSIFIED** (inference is 93.7% of per-call cost, *not* infra; no amortization) · H3 HELD |
| **EXP-002** | agent-commerce forensics | Is the on-chain agent economy real commerce? | **Registration theater** — 39,999 registered → ~0 transacting; $320.9M of "commerce" was prize distribution |
| **EXP-003** | verify-the-void | Is the verification market a place to build? | **GO-vertical / NO-GO-horizontal** — demand is real but vertical + in-house; deterministic verification is the moat |
| **EXP-004** | graduation gate | *(next)* Can the forensic score prove itself? | Pre-registered: a real sybil layer + a precision/recall validation harness — the substrate the product needs *first* |

The spine renders this at [`observatory/`](observatory/) (`npm --prefix observatory run dev`). The method came out of EXP-001 and held across all four — see [`grimoires/loa/context/epistemology-deterministic-layers.md`](grimoires/loa/context/epistemology-deterministic-layers.md).

**The standing lesson** (earned the hard way, score-api #269): *a deterministic formula is not the product.* The validated substrate — a real sybil layer, labeled ground-truth, measured precision/recall — must exist before any "forensic" claim. EXP-004 is that gate. And *a converged review pass is not verification*: independent cross-model review still caught real defects in code that had already "passed." Both lessons are load-bearing here.

## The substrate it rides on

The runtime is real and grounded — it's what makes the experiments cheap (`~$0` marginal at the cheapest tier) and reproducible.

- **Cost meter** — per-request 3-ledger record (inference / infra / orchestration), hash-chained, integer micro-USD, **closes before the response returns** and is immutable once written ([`src/cost/cost-atom.ts`](src/cost/cost-atom.ts)). This is the instrument EXP-001 read.
- **Score core** — deterministic, **no-LLM** forensic scoring (`src/score/`). Sprint-1 (leaderboard / features / cluster / screen) is pure and unit-tested; the on-chain edge adapters are `NotImplementedError` by design (fixtures-only until EXP-004 builds the validated substrate).
- **Multi-model routing** — alias resolution, capability matching, budget enforcement, fallback chains ([`src/hounfour/router.ts`](src/hounfour/router.ts)).
- **Write-ahead log** — append-only WAL with R2 checkpoint + Git archive for crash recovery ([`src/persistence/wal.ts`](src/persistence/wal.ts)).
- **Cron + sandbox + audit** — circuit-breakered jobs ([`src/cron/service.ts`](src/cron/service.ts)), worker-thread tool isolation with a filesystem jail ([`src/agent/sandbox.ts`](src/agent/sandbox.ts)), and a SHA-256 hash-chained audit trail ([`src/safety/audit-trail.ts`](src/safety/audit-trail.ts)).
- **Cost-safe on-chain data** routes through [`@freeside/dune-meter`](https://github.com/0xHoneyJar/loa-freeside) — cost-capped, metered, never raw Dune (the EXP-002 budget scar, made structurally impossible).

## Quick Start

**Prerequisites:** Node.js 22+, `ANTHROPIC_API_KEY`.

```bash
git clone https://github.com/0xHoneyJar/loa-finn && cd loa-finn
npm install
export ANTHROPIC_API_KEY=sk-ant-...

npm run dev                       # runtime — http://localhost:3000, health at GET /health
npm --prefix observatory run dev  # the research spine
docker compose up                 # or run containerized
```

## Module Map

| Module | Purpose |
|--------|---------|
| **cost** | The hash-chained per-request cost meter — the experiment instrument |
| **score** | Deterministic no-LLM forensic scoring (Sprint-1 core; substrate is EXP-004) |
| **hounfour** | Multi-model routing, budget, JWT, orchestration |
| **gateway** | HTTP API, WebSocket, auth, rate limiting |
| **persistence** | WAL, R2 sync, Git sync, crash recovery |
| **cron** / **scheduler** | Scheduled jobs with circuit breakers + health |
| **agent** | Session management, sandbox, worker pool |
| **safety** | Audit trail, firewall, secret redaction |
| **substrate** | Effect-loader runtime + EventStore bridge |
| **bridgebuilder** | GitHub PR review automation |

## Documentation

| Topic | Where |
|---|---|
| Experiment program + epistemology | [`grimoires/loa/context/`](grimoires/loa/context/) (epistemology, experiment-economics, the EXP pre-registrations) |
| Research spine | [`observatory/`](observatory/) |
| Architecture · Operations · API | [docs/architecture.md](docs/architecture.md) · [docs/operations.md](docs/operations.md) · [docs/api-reference.md](docs/api-reference.md) |
| Security · Contributing · Changelog | [SECURITY.md](SECURITY.md) · [CONTRIBUTING.md](CONTRIBUTING.md) · [CHANGELOG.md](CHANGELOG.md) |

## Known limitations (honest)

- **Score edges are unbuilt** — `src/score/edge/` throws `NotImplementedError`; the core runs on fixtures, and no precision/recall harness exists *yet* (that's EXP-004). No "forensic/court-admissible" claim is earned until both EXP-004 kill gates fire.
- **Single-writer WAL** — no concurrent sessions per WAL file ([`src/persistence/wal.ts`](src/persistence/wal.ts)).
- **No horizontal scaling** — single Hono instance per deployment.
- **BridgeBuilder COMMENTs only** — it cannot APPROVE or REQUEST_CHANGES.

## Status & License

Active. The experiment program is at **EXP-004 (graduation gate)**; the runtime is in production-shaped use. Maintainer: [@janitooor](https://github.com/janitooor).

[AGPL-3.0](LICENSE.md) — use, modify, distribute freely; network deployments must release source. Commercial licenses available.

---

*Ridden with [Loa](https://github.com/0xHoneyJar/loa). Appraised by the Finn.*
