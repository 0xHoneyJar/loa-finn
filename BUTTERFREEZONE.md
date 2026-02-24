<!-- AGENT-CONTEXT
name: loa-finn
type: framework
purpose: Minimal persistent Loa agent runtime using Pi SDK
key_files: [CLAUDE.md, .claude/loa/CLAUDE.loa.md, .loa.config.yaml, .claude/scripts/, .claude/skills/, package.json]
interfaces:
  core: [/auditing-security, /autonomous-agent, /bridgebuilder-review, /browsing-constructs, /bug-triaging]
  project: [/ground-truth]
dependencies: [git, jq, yq, node]
capability_requirements:
  - filesystem: read
  - filesystem: write (scope: state)
  - filesystem: write (scope: app)
  - git: read_write
  - shell: execute
  - github_api: read_write (scope: external)
version: v1.29.0
trust_level: L3-hardened
-->

# loa-finn

<!-- provenance: DERIVED -->
Minimal persistent Loa agent runtime using Pi SDK

The framework provides 30 specialized skills, built with TypeScript/JavaScript, Python, Shell.

## Key Capabilities
<!-- provenance: DERIVED -->
The project exposes 15 key entry points across its public API surface.

### .claude/adapters

- **_build_provider_config** — Build ProviderConfig from merged hounfour config. (`.claude/adapters/cheval.py:152`)
- **_check_feature_flags** — Check feature flags. (`.claude/adapters/cheval.py:192`)
- **_error_json** — Format error as JSON for stderr (SDD §4.2.2 Error Taxonomy). (`.claude/adapters/cheval.py:77`)
- **_load_persona** — Load persona.md for the given agent with optional system merge (SDD §4.3.2). (`.claude/adapters/cheval.py:96`)
- **cmd_cancel** — Cancel a Deep Research interaction. (`.claude/adapters/cheval.py:511`)
- **cmd_invoke** — Main invocation: resolve agent → call provider → return response. (`.claude/adapters/cheval.py:211`)
- **cmd_poll** — Poll a Deep Research interaction. (`.claude/adapters/cheval.py:467`)
- **cmd_print_config** — Print effective merged config with source annotations. (`.claude/adapters/cheval.py:442`)
- **cmd_validate_bindings** — Validate all agent bindings. (`.claude/adapters/cheval.py:453`)
- **main** — CLI entry point. (`.claude/adapters/cheval.py:547`)

### .claude/adapters/loa_cheval/config

- **LazyValue** — Deferred interpolation token. (`.claude/adapters/loa_cheval/config/interpolation.py:41`)
- **_check_env_allowed** — Check if env var name is in the allowlist. (`.claude/adapters/loa_cheval/config/interpolation.py:122`)
- **_check_file_allowed** — Validate and resolve a file path for secret reading. (`.claude/adapters/loa_cheval/config/interpolation.py:133`)
- **_get_credential_provider** — Get the credential provider chain (lazily initialized, thread-safe). (`.claude/adapters/loa_cheval/config/interpolation.py:192`)
- **_matches_lazy_path** — Check if a dotted config key path matches any lazy path pattern. (`.claude/adapters/loa_cheval/config/interpolation.py:275`)

## Architecture
<!-- provenance: DERIVED -->
The architecture follows a three-zone model: System (`.claude/`) contains framework-managed scripts and skills, State (`grimoires/`, `.beads/`) holds project-specific artifacts and memory, and App (`src/`, `lib/`) contains developer-owned application code. The framework orchestrates 30 specialized skills through slash commands.
```mermaid
graph TD
    adapters[adapters]
    config[config]
    deploy[deploy]
    docker_entrypoint_initdb_d[docker-entrypoint-initdb.d]
    docs[docs]
    drizzle[drizzle]
    evals[evals]
    grimoires[grimoires]
    Root[Project Root]
    Root --> adapters
    Root --> config
    Root --> deploy
    Root --> docker_entrypoint_initdb_d
    Root --> docs
    Root --> drizzle
    Root --> evals
    Root --> grimoires
```
Directory structure:
```
./adapters
./adapters/__pycache__
./adapters/fixtures
./config
./deploy
./deploy/grafana
./deploy/k8s
./deploy/prometheus
./deploy/terraform
./deploy/vllm
./deploy/workflows
./dist
./docker-entrypoint-initdb.d
./docs
./docs/adr
./docs/architecture
./docs/archive
./docs/modules
./docs/runbooks
./drizzle
./drizzle/meta
./evals
./evals/baselines
./evals/fixtures
./evals/graders
./evals/harness
./evals/results
./evals/suites
./evals/tasks
./evals/tests
```

## Interfaces
<!-- provenance: DERIVED -->
### HTTP Routes

- **GET** `/:collection/:tokenId` (`src/gateway/routes/agent-homepage.ts:31`)
- **GET** `/:id/messages` (`src/gateway/routes/conversations.ts:105`)
- **GET** `/` (`src/gateway/jwks.ts:76`)
- **GET** `/` (`src/gateway/metrics-endpoint.ts:254`)
- **GET** `/` (`src/gateway/routes/conversations.ts:74`)
- **GET** `/agent/:tokenId` (`src/gateway/routes/discovery.ts:58`)
- **GET** `/agents.md` (`src/gateway/routes/discovery.ts:50`)
- **GET** `/balance` (`src/credits/routes.ts:46`)
- **GET** `/feature-flags` (`src/gateway/feature-flags.ts:144`)
- **GET** `/history` (`src/credits/routes.ts:78`)
- **GET** `/llms.txt` (`src/gateway/routes/discovery.ts:42`)
- **GET** `/openapi.json` (`src/gateway/routes/discovery.ts:37`)
- **GET** `/public` (`src/gateway/routes/agent-public-api.ts:49`)
- **POST** `/` (`src/gateway/routes/agent-chat.ts:53`)
- **POST** `/` (`src/gateway/routes/conversations.ts:45`)

### Skill Commands

#### Loa Core

- **/auditing-security** — Paranoid Cypherpunk Auditor
- **/autonomous-agent** — Autonomous agent
- **/bridgebuilder-review** — Bridgebuilder — Autonomous PR Review
- **/browsing-constructs** — Provide a multi-select UI for browsing and installing packs from the Loa Constructs Registry. Enables composable skill installation per-repo.
- **/bug-triaging** — Bug Triage Skill
- **/butterfreezone-gen** — BUTTERFREEZONE Generation Skill
- **/continuous-learning** — Continuous Learning Skill
- **/deploying-infrastructure** — Deploying infrastructure
- **/designing-architecture** — Architecture Designer
- **/discovering-requirements** — Discovering Requirements
- **/enhancing-prompts** — Enhancing prompts
- **/eval-running** — Eval running
- **/flatline-knowledge** — Provides optional NotebookLM integration for the Flatline Protocol, enabling external knowledge retrieval from curated AI-powered notebooks.
- **/flatline-reviewer** — Flatline reviewer
- **/flatline-scorer** — Flatline scorer
- **/flatline-skeptic** — Flatline skeptic
- **/gpt-reviewer** — Gpt reviewer
- **/implementing-tasks** — Sprint Task Implementer
- **/managing-credentials** — /loa-credentials — Credential Management
- **/mounting-framework** — Create structure (preserve if exists)
- **/planning-sprints** — Sprint Planner
- **/red-teaming** — Use the Flatline Protocol's red team mode to generate creative attack scenarios against design documents. Produces structured attack scenarios with consensus classification and architectural counter-designs.
- **/reviewing-code** — Senior Tech Lead Reviewer
- **/riding-codebase** — Riding Through the Codebase
- **/rtfm-testing** — RTFM Testing Skill
- **/run-bridge** — Run Bridge — Autonomous Excellence Loop
- **/run-mode** — Run mode
- **/simstim-workflow** — Check post-PR state
- **/translating-for-executives** — Translating for executives
#### Project-Specific

- **/ground-truth** — Ground Truth — Factual GTM Document Generation

## Module Map
<!-- provenance: DERIVED -->
| Module | Files | Purpose | Documentation |
|--------|-------|---------|---------------|
| `adapters/` | 47 | Adapters | \u2014 |
| `config/` | 1 | Configuration files | \u2014 |
| `deploy/` | 24 | Infrastructure and deployment | \u2014 |
| `docker-entrypoint-initdb.d/` | 1 | Docker entrypoint initdb.d | \u2014 |
| `docs/` | 34 | Documentation | \u2014 |
| `drizzle/` | 4 | Drizzle | \u2014 |
| `evals/` | 122 | Benchmarking and regression framework for the Loa agent development system. Ensures framework changes don't degrade agent behavior through | [evals/README.md](evals/README.md) |
| `grimoires/` | 908 | Home to all grimoire directories for the Loa | [grimoires/README.md](grimoires/README.md) |
| `infrastructure/` | 5 | Infrastructure | \u2014 |
| `packages/` | 5 | Packages | \u2014 |
| `public/` | 16 | Static assets | \u2014 |
| `schemas/` | 3 | Schemas | \u2014 |
| `scripts/` | 8 | Utility scripts | \u2014 |
| `src/` | 321 | Source code | \u2014 |
| `tests/` | 493 | Test suites | \u2014 |

## Verification
<!-- provenance: CODE-FACTUAL -->
- Trust Level: **L3 — Property-Based**
- 508 test files across 1 suite
- CI/CD: GitHub Actions (11 workflows)
- Type safety: TypeScript
- Security: SECURITY.md present

## Agents
<!-- provenance: DERIVED -->
The project defines 1 specialized agent persona.

| Agent | Identity | Voice |
|-------|----------|-------|
| Bridgebuilder | You are the Bridgebuilder — a senior engineering mentor who has spent decades building systems at scale. | Your voice is warm, precise, and rich with analogy. |

## Ecosystem
<!-- provenance: OPERATIONAL -->
### Dependencies
- `@0xhoneyjar/loa-hounfour`
- `@aws-sdk/client-s3`
- `@hono/node-server`
- `@mariozechner/pi-agent-core`
- `@mariozechner/pi-ai`
- `@mariozechner/pi-coding-agent`
- `@sinclair/typebox`
- `@types/bcrypt`
- `@types/json-stable-stringify`
- `@types/node`
- `@types/ws`
- `bcrypt`
- `croner`
- `drizzle-kit`
- `drizzle-orm`
- `eslint`
- `fast-check`
- `hono`
- `jose`
- `json-stable-stringify`

## Known Limitations
<!-- provenance: DERIVED -->

<!-- provenance: CODE-FACTUAL -->
- Single-writer WAL — no concurrent sessions per WAL file (`src/persistence/wal.ts:1`)
- No horizontal scaling — single Hono instance per deployment (`src/gateway/server.ts:1`)
- Tool sandbox 30s default timeout — long-running tools may be killed (`src/config.ts:1`)
- BridgeBuilder can only COMMENT on PRs, not APPROVE or REQUEST_CHANGES (`src/bridgebuilder/entry.ts:1`)

<!-- ground-truth-meta: head_sha=689a777 generated_at=2026-02-11T01:06:00Z features_sha=689a777 limitations_sha=689a777 ride_sha=689a777 -->

## Quick Start
<!-- provenance: OPERATIONAL -->

### Prerequisites

<!-- provenance: OPERATIONAL -->
- Node.js 22+ (`"engines": { "node": ">=22" }` in `package.json`)
- `ANTHROPIC_API_KEY` environment variable set

### Run Locally

```bash
# Clone and install
git clone <repo-url> && cd loa-finn
npm install

# Set required environment
export ANTHROPIC_API_KEY=sk-ant-...

# Start development server (tsx watch)
npm run dev
```
<!-- ground-truth-meta
head_sha: dfedce60cb97e96716e242f87e260fe214b886ba
generated_at: 2026-02-24T10:49:49Z
generator: butterfreezone-gen v1.0.0
sections:
  agent_context: 95bd673ed24113b3d1a76cb1920d094fc42d71d22613c112c99f5b89566b3266
  capabilities: ab2576b1f2e7e8141f0e93e807d26ed2b7b155e21c96d787507a3ba933bb9795
  architecture: 228039a98daa4141d7298f982aedbfd0088c1328a6eecfc9060247dfb2c5a195
  interfaces: ee958816c9a4a9151de255e147d02a9cc410e2794126611deebfd0585a8b818f
  module_map: 0a7a945012e6ddddc3ccbb338e0b0180236611a9222df7138462807ed3bc7aa5
  verification: 37ad3256397bdc9c123157e207a49aa1e541d57b424694a52f10315a9eb19a94
  agents: ca263d1e05fd123434a21ef574fc8d76b559d22060719640a1f060527ef6a0b6
  ecosystem: 4874e32c0011304eaaf21db5a578ff094727c85104b8272897edbeda0498bb64
  limitations: 5dbb86bb1798604cdafad4930eb8e2265e99837ad33674f99e66de49dad71bfd
  quick_start: d1b43139021ae877a9f5d45f030c06b6eb84d4f84bebcf89343117dd668a4b53
-->
