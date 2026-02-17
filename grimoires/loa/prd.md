# PRD: The Oracle — From Engine to Product (loa-dixie Phase 1)

> **Version**: 3.0.0
> **Date**: 2026-02-17
> **Author**: @janitooor + Bridgebuilder
> **Status**: Draft
> **Cycle**: cycle-025 (extended)
> **Predecessor**: PRD v2.0.0 — Oracle Knowledge Engine (Phase 0, IMPLEMENTED)
> **Command Center**: [#66](https://github.com/0xHoneyJar/loa-finn/issues/66)
> **RFC**: [#74 — The Oracle](https://github.com/0xHoneyJar/loa-finn/issues/74) · [loa-dixie #1 — Genesis](https://github.com/0xHoneyJar/loa-dixie/issues/1)
> **Cross-references**: [loa-finn PR #75](https://github.com/0xHoneyJar/loa-finn/pull/75) (Oracle engine, ready to merge) · [loa-dixie RFC](https://github.com/0xHoneyJar/loa-dixie/blob/main/docs/rfc.md) · [#31 Hounfour RFC](https://github.com/0xHoneyJar/loa-finn/issues/31) · [loa #247 Meeting Geometries](https://github.com/0xHoneyJar/loa/issues/247) · [arrakis #62 Billing](https://github.com/0xHoneyJar/arrakis/issues/62) · [loa-hounfour PR #2](https://github.com/0xHoneyJar/loa-hounfour/pull/2)
> **Grounding**: `src/hounfour/knowledge-{enricher,loader,registry,types}.ts` (Phase 0 engine), `deploy/terraform/finn.tf` (ECS infra), loa-dixie `knowledge/` (10 curated sources, ~140KB), loa-dixie `docs/rfc.md` (phased roadmap)
> **Naming**: McCoy Pauley's ROM construct — "The Dixie Flatline" — a recorded consciousness that carries accumulated expertise and can be consulted by anyone who needs understanding.

---

## 0. Phase 0 Recap (IMPLEMENTED — PRD v2.0.0)

Phase 0 built the Oracle's **engine** inside loa-finn. This work is complete in PR #75 (107 tests, GPT-5.2 + Flatline approved, review + audit passed):

| Component | Status | Location |
|-----------|--------|----------|
| Knowledge Types | Done | `src/hounfour/knowledge-types.ts` (80 LOC) |
| Knowledge Loader (5-gate security) | Done | `src/hounfour/knowledge-loader.ts` (141 LOC) |
| Knowledge Registry (health checks) | Done | `src/hounfour/knowledge-registry.ts` (161 LOC) |
| Knowledge Enricher (tag classifier + budget) | Done | `src/hounfour/knowledge-enricher.ts` (244 LOC) |
| Router integration (3 invoke methods) | Done | `src/hounfour/router.ts` (modified) |
| Type extensions (AgentBinding, ResultMetadata) | Done | `src/hounfour/types.ts` (modified) |
| Config extensions (FINN_ORACLE_ENABLED) | Done | `src/config.ts` (modified) |
| Health + error handling | Done | `src/gateway/routes/invoke.ts` (modified) |
| Test suite (107 tests across 6 files) | Done | `tests/finn/knowledge-*.test.ts`, `oracle-*.test.ts` |
| Knowledge corpus (10 curated sources, ~72K tokens) | Done | `grimoires/oracle/` |
| Oracle persona | Done | `grimoires/oracle-persona.md` |

**What Phase 0 proved**: The knowledge enrichment pipeline works. Tag-based classification is deterministic and testable. The trust boundary prevents injection. Budget enforcement is exact. The Oracle can answer questions at multiple abstraction levels with source attribution.

**What Phase 0 lacks**: No one can reach it. The Oracle lives behind an API endpoint (`POST /api/v1/invoke { agent: "oracle" }`) with no frontend, no public URL, and no product surface. It's an engine with no vehicle.

---

## 1. Problem Statement

### The Phase 1 Problem

The Oracle engine is built. 600 lines of TypeScript, 107 tests, 10 curated knowledge sources covering 82K+ lines across 4 repositories. It works. It's approved. It's sitting in a PR.

But nobody can use it.

There is no website. No public endpoint. No way for an engineer, contributor, community member, or investor to type a question and get an answer. The engine exists; the product does not.

### Why Phase 1 Matters Beyond the Oracle

The Oracle is the **first dNFT product** in the HoneyJar ecosystem. The infrastructure built for `oracle.arrakis.community` — subdomain routing, frontend hosting, API layer, knowledge sync — becomes the **template for every future finnNFT website**. When the next bear NFT or community agent needs its own web presence, the pattern already exists.

This is not just "ship a chatbot." This is "build the platform by building the first product on it."

### Vision (Extended)

**Phase 0 vision**: A unified knowledge interface that anyone can query at any level.
**Phase 1 vision**: That interface, live at `oracle.arrakis.community`, accessible to anyone with a browser, with the infrastructure to serve every future dNFT the same way.

---

## 2. Goals & Success Metrics

### Goals

| # | Goal | Measurable Outcome |
|---|------|--------------------|
| G1 | Oracle live and publicly accessible | `oracle.arrakis.community` serves the chat interface |
| G2 | Product-grade API | `/api/v1/oracle` endpoint with simpler DX than raw invoke |
| G3 | Extended knowledge corpus | 20+ sources across all 7 abstraction levels |
| G4 | Source attribution visible to users | Every response shows which sources informed the answer |
| G5 | Reusable dNFT website infrastructure | Terraform module supports adding new subdomains with minimal config |
| G6 | Knowledge single source of truth | loa-dixie repo is canonical; loa-finn consumes at build time |
| G7 | Migration-ready hosting | S3+CloudFront now, clean path to Cloudflare Pages later |

### Non-Goals (This Phase)

| # | Non-Goal | Why Deferred |
|---|----------|-------------|
| NG1 | Vector embedding / semantic search | Phase 2 (Scholar); tag-based classification is sufficient for 20 sources |
| NG2 | dNFT on-chain identity | Phase 4 (Citizen); requires smart contract work |
| NG3 | x402 micropayments | Phase 5; requires arrakis x402 middleware integration |
| NG4 | Session-based conversations | Future; API designed to support it without breaking changes |
| NG5 | Custom domain (0xhoneyjar.xyz) | DNS not yet in Route 53; using arrakis.community for speed |
| NG6 | Ceremony participation | Phase 3 (Participant); requires ceremony engine from loa#247 |

### Success Metrics

| Metric | Target | How Measured |
|--------|--------|-------------|
| Site loads and serves queries | 100% uptime during demo | CloudFront + health check |
| Response includes source citations | Every response | API response metadata + UI display |
| Gold-set accuracy (source selection) | ≥90% of 20 test queries pass (see §4 FR-3 gold-set contract) | Automated CI gold-set test suite |
| Deterministic selection | Same query + same corpus + same config = identical source IDs and ordering | CI test: run same query twice, assert `sources[].id` ordering and `total_knowledge_tokens` are byte-identical |
| Response latency (cached sources) | < 3s to first token | API metadata `knowledge_retrieval_ms` |
| Knowledge corpus coverage | 20+ sources, all 7 levels | `sources.json` validation |
| Subdomain reusability | Second subdomain deployable with <50 lines of Terraform | Terraform module interface |

---

## 3. User & Stakeholder Context

### Personas & Tiers

| Persona | Example Question | Access Tier | Authentication |
|---------|-----------------|-------------|---------------|
| **Engineer** | "How does the billing settlement flow work?" | Developer | JWT or API key |
| **Contributor** | "How do I add a new model adapter?" | Community | None (public) or NFT-gated |
| **Product Manager** | "What's the Oracle's revenue model?" | Developer/Enterprise | JWT |
| **Community Member** | "What can my bear NFT do?" | Public | None |
| **Investor** | "How does the x402 payment flow work?" | Enterprise | JWT |
| **Curious Observer** | "What is this project?" | Public | None |

### Tier Model (Phase 1 MVP)

| Tier | Rate Limit | Auth | Sources |
|------|-----------|------|---------|
| **Public** | 5 questions/day | None (IP-based rate limit) | Full corpus |
| **Authenticated** | 50 questions/day | Bearer token (opaque API key, manually issued) | Full corpus |

The RFC defines Community (NFT-gated), Developer ($10/mo), and Enterprise (custom) tiers — these require arrakis billing integration and are deferred to Phase 4-5.

### Rate Limiting & Auth Specification (GPT-5.2 SKP-001)

**Client identity derivation**: The request traverses CloudFront → ALB → ECS. The trusted client IP is extracted from the **last entry** in the `X-Forwarded-For` header as set by the ALB (which appends the true source IP). User-supplied `X-Forwarded-For` values are ignored — only the ALB-appended IP is used. Implementation: parse `X-Forwarded-For`, take the rightmost IP before the ALB's own address.

**Authenticated token format**: Phase 1 uses **opaque API keys** (32-byte hex strings, e.g., `dk_live_a1b2c3...`). Keys are stored server-side as SHA-256 hashes in Redis (`oracle:apikeys:{hash} → { quota_remaining, tier, issued_at }`). No JWT complexity for Phase 1 — JWTs are deferred to arrakis billing integration (Phase 4-5).

**Precedence rule**: If a valid `Authorization: Bearer dk_live_...` header is present and the key validates, apply the **authenticated tier quota** (50/day). Otherwise, fall back to **public tier quota** (5/day per IP). Both quotas are tracked in Redis with 24-hour TTL keys (`oracle:ratelimit:ip:{ip}:{date}` and `oracle:ratelimit:key:{hash}:{date}`).

**Acceptance tests**: CI must include tests that (a) confirm spoofed `X-Forwarded-For` headers do not bypass the IP limiter, (b) confirm invalid/expired API keys fall back to IP-based limiting, (c) confirm the 6th request from the same IP within 24h returns HTTP 429.

> **Flatline SKP-001 (Override)**: Skeptic flagged X-Forwarded-For as brittle. The ALB-appended IP extraction specified above is adequate for Phase 1 — CloudFront-Viewer-Address is a refinement for SDD. Rationale: the ALB is the only trusted proxy in the chain, and the rightmost-appended IP is the standard AWS pattern.

**Global cost protection (Flatline SKP-002 + SKP-001b)**:
- **Global daily budget**: Hard cap of 200 Oracle invocations/day across all sources (IPs + API keys combined). Tracked in Redis as `oracle:global:{date}` counter. When exceeded, all Oracle requests return HTTP 503 with `Retry-After: {seconds-until-midnight-UTC}`. Configurable via `FINN_ORACLE_DAILY_CAP` env var.
- **Cost circuit breaker**: If cumulative daily model inference spend for Oracle queries exceeds `$20` (configurable via `FINN_ORACLE_COST_CEILING_CENTS=2000`), the Oracle auto-disables until midnight UTC. Tracked via existing billing metering. CloudWatch alarm fires immediately.
- **Honest latency target**: Non-streaming Phase 1 targets **< 15s p95 time-to-complete-response** (not "first token"). Frontend displays a typing animation / progress indicator during the wait. Requests exceeding 30s are terminated with HTTP 504.

**Minimal key lifecycle (Flatline SKP-006)**:
- Admin CLI script: `scripts/oracle-keys.sh create|revoke|list`. Creates keys with prefix `dk_live_` (prod) or `dk_test_` (dev).
- Key status in Redis: `oracle:apikeys:{hash} → { status: "active"|"revoked", owner, created_at, last_used_at }`.
- Revocation is immediate (Redis delete of active status). Revoked keys return HTTP 401.
- Audit: key creation and revocation events logged to CloudWatch (structured JSON). No rotation or scoped keys for Phase 1.

---

## 4. Functional Requirements

### Phase 1 Scope Overview

```
                    ┌────────────────────────────────────────┐
                    │     oracle.arrakis.community (NEW)      │
                    │     Next.js on S3 + CloudFront          │
                    │     Chat UI + source attribution        │
                    └──────────────┬─────────────────────────┘
                                   │ HTTPS
                                   ▼
                    ┌────────────────────────────────────────┐
                    │     /api/v1/oracle (NEW convenience)    │
                    │     Thin wrapper over /invoke            │
                    │     Rate limiting, CORS, simpler DX     │
                    └──────────────┬─────────────────────────┘
                                   │ internal
                                   ▼
                    ┌────────────────────────────────────────┐
                    │     /api/v1/invoke { agent: "oracle" }  │
                    │     (EXISTING — Phase 0, PR #75)        │
                    │     Knowledge enrichment pipeline        │
                    └──────────────┬─────────────────────────┘
                                   │ reads at startup
                                   ▼
                    ┌────────────────────────────────────────┐
                    │     Knowledge Corpus (loa-dixie)         │
                    │     20+ sources, ~150K tokens            │
                    │     Synced at Docker build time          │
                    └────────────────────────────────────────┘
```

---

### FR-1: Merge & Deploy Oracle Engine (Phase 0 → Production)

Merge PR #75 into main and deploy loa-finn with `FINN_ORACLE_ENABLED=true`.

**Prerequisite**: PR #75 is clean — 107 tests, review + audit passed, no merge conflicts, 10 commits ahead of main.

**Acceptance Criteria**:
- [ ] PR #75 merged to main
- [ ] Docker image built with Oracle knowledge sources included
- [ ] loa-finn deployed to ECS with `FINN_ORACLE_ENABLED=true`
- [ ] `/health` reports `oracle_ready: true`
- [ ] `POST /api/v1/invoke { agent: "oracle", prompt: "What is loa-finn?" }` returns a grounded response
- [ ] Existing non-Oracle invoke requests are unaffected

---

### FR-2: Oracle Product API (`/api/v1/oracle`)

A product-grade convenience endpoint that wraps the existing invoke infrastructure. This follows the **BFF (Backend for Frontend) pattern** — the same approach Netflix (Zuul), Spotify, and Stripe use to separate product-facing APIs from internal service APIs.

**Why a separate endpoint (FAANG rationale)**:
The internal `/api/v1/invoke` endpoint is a multi-agent routing API. Its request format (`{ agent, prompt, options }`) and response format (full invoke metadata) are designed for programmatic consumers. A product API should match the mental model of the product: "I have a question, give me an answer with sources."

**Request format**:
```typescript
POST /api/v1/oracle
Content-Type: application/json

{
  "question": "How does the billing settlement flow work?",
  "context"?: "I'm looking at the arrakis credit ledger",  // optional
  "session_id"?: "abc-123"  // reserved for future use, ignored in Phase 1
}
```

**Response format (non-streaming)**:
```typescript
{
  "answer": "The billing settlement flow...",
  "sources": [
    { "id": "code-reality-arrakis", "tags": ["billing", "arrakis"], "tokens_used": 5200 },
    { "id": "rfcs", "tags": ["billing", "architecture"], "tokens_used": 3100 }
  ],
  "metadata": {
    "knowledge_mode": "full",           // "full" | "reduced"
    "total_knowledge_tokens": 8300,
    "knowledge_budget": 30000,
    "retrieval_ms": 12,
    "model": "claude-sonnet-4-5-20250929",  // or whatever was routed
    "session_id": null                  // null until sessions implemented
  }
}
```

**Streaming protocol (GPT-5.2 SKP-004)**: Phase 1 uses **non-streaming responses only**. The frontend displays a loading state while the full response is generated, then renders the complete answer with sources. Streaming (SSE via `/api/v1/oracle/stream`) is deferred to a follow-up iteration after Phase 1 ships, because: (a) the existing Hounfour invoke pipeline does not expose a streaming interface, (b) source attribution metadata is only available after full generation, and (c) non-streaming is simpler to test and debug. The API response shape above is the complete contract for Phase 1.

**Internal routing**: The endpoint translates `{ question, context }` into `{ agent: "oracle", prompt: question + context }`, calls the existing invoke pipeline, and reshapes the response.

**Acceptance Criteria**:
- [ ] `POST /api/v1/oracle` endpoint registered in gateway routes
- [ ] Request validation: `question` required (string, 1-10000 chars), `context` optional
- [ ] Internally delegates to existing Hounfour invoke with `agent: "oracle"`
- [ ] Response reshaping: `answer` + `sources` array + `metadata` object
- [ ] CORS headers for `oracle.arrakis.community` origin
- [ ] Rate limiting: 5 requests/day per IP (public), 50/day per token (authenticated)
- [ ] Rate limit backed by existing Redis (arrakis ElastiCache)
- [ ] `session_id` accepted but ignored (reserved field, returns null)
- [ ] Error responses: 400 (validation), 429 (rate limited), 503 (Oracle unavailable)
- [ ] API version header: responses include `X-Oracle-API-Version: 2026-02-17` (date-based versioning, Flatline IMP-002). Future breaking changes increment the date. Clients can send `Oracle-API-Version` request header to pin behavior. Deprecation policy: old versions supported for 90 days after successor ships, with `Sunset` response header per RFC 8594.

---

### FR-3: Extended Knowledge Corpus (20+ Sources)

Expand from 10 sources (~72K tokens) to 20+ sources (~150K tokens) covering all 7 abstraction levels defined in the loa-dixie RFC.

**Source Taxonomy (7 levels)**:

| Level | Audience | Current Sources | New Sources (Phase 1) |
|-------|----------|----------------|----------------------|
| **Code** | Engineers | `code-reality-finn`, `code-reality-hounfour`, `code-reality-arrakis` | `code-reality-loa` (framework API surface) |
| **Architecture** | Tech leads | `ecosystem-architecture` | `architecture-decisions` (ADR log across 25 cycles) |
| **Product** | PMs | — | `product-vision` (PRD summaries), `feature-matrix` (what each repo provides) |
| **Process** | Contributors | `development-history` | `sprint-patterns` (what sprint cadence looks like), `onboarding-guide` (how to contribute) |
| **Cultural** | Community | `glossary`, `meeting-geometries`, `web4-manifesto` | `naming-mythology` (why Finn, Dixie, Arrakis, Hounfour), `community-principles` |
| **Economic** | Investors | — | `pricing-model` (tier structure, x402 vision), `tokenomics-overview` (dNFT identity, credit ledger) |
| **Educational** | Everyone | `rfcs`, `bridgebuilder-reports` | `faang-parallels` (curated from 54+ field reports), `lessons-learned` (cycle retro highlights) |

**New sources (minimum 10 additions)**:

| Source ID | Level | Est. Tokens | Priority |
|-----------|-------|-------------|----------|
| `code-reality-loa` | Code | ~8K | 3 |
| `architecture-decisions` | Architecture | ~6K | 4 |
| `product-vision` | Product | ~4K | 5 |
| `feature-matrix` | Product | ~3K | 6 |
| `sprint-patterns` | Process | ~3K | 7 |
| `onboarding-guide` | Process | ~5K | 5 |
| `naming-mythology` | Cultural | ~4K | 8 |
| `community-principles` | Cultural | ~3K | 8 |
| `pricing-model` | Economic | ~4K | 6 |
| `tokenomics-overview` | Economic | ~5K | 7 |
| `faang-parallels` | Educational | ~8K | 9 |
| `lessons-learned` | Educational | ~5K | 9 |

**Canonical home**: All sources live in `loa-dixie/knowledge/sources/`. The `sources.json` registry lives in `loa-dixie/knowledge/sources.json`.

**Acceptance Criteria**:
- [ ] 20+ knowledge sources in loa-dixie with YAML frontmatter provenance
- [ ] All 7 abstraction levels covered with at least 2 sources each
- [ ] Each source passes injection detection (5-gate loader)
- [ ] `sources.json` updated with all new sources, priorities, tags, and freshness policies
- [ ] Total corpus ≤ 200K tokens (budget enforcement handles selection)
- [ ] Gold-set test suite expanded: 20 queries (at least 2 per abstraction level)

**Gold-set contract (GPT-5.2 SKP-002)**: Each gold-set query specifies:
- `query`: The test question
- `required_sources`: Source IDs that MUST appear in the selected set (fail if missing)
- `forbidden_sources`: Source IDs that MUST NOT appear (fail if present)
- `max_selected`: Maximum number of sources selected (fail if exceeded)
- A query passes if all required sources are present, no forbidden sources are present, and source count ≤ max_selected. The 90% target means ≥18 of 20 queries pass.

**Deterministic ordering contract**: Sources are sorted by (1) tag match count DESC, (2) priority ASC (lower = higher priority), (3) source ID alphabetical ASC. The tag classifier version is pinned in `sources.json` (`"classifier_version": "1.0"`). Any classifier change increments the version and requires gold-set re-validation. The `/api/v1/oracle` response includes `sources[].id` in the exact order used by the enricher, enabling CI to assert ordering stability.

**Two-tier test strategy (Flatline SKP-004)**: Testing is split into two levels:
- **Tier 1 — Deterministic unit tests (blocking CI)**: Test the classifier and enricher directly with mock corpus. Assert exact source ordering, exact token counts, exact tag assignments. These are fully deterministic and must pass on every build.
- **Tier 2 — Gold-set integration tests (non-blocking initially)**: Run 20 gold-set queries through the full Oracle API (or invoke pipeline). Use flexible pass criteria: required sources must appear in the selected top-K (not exact position). Run as a CI signal (reported but not gating) for the first 2 sprints. Promoted to blocking CI after stability is demonstrated across 10+ builds. Gold-set is versioned per corpus version (`gold-set-v1.0.json`).

---

### FR-4: Knowledge Sync Pipeline (loa-dixie → loa-finn)

Establish loa-dixie as the single source of truth for knowledge, consumed by loa-finn at build time.

**Strategy**: CI-copy at Docker build time. The Dockerfile clones loa-dixie (or fetches a release archive) and copies knowledge sources into the image. This is the simplest approach that avoids runtime network dependencies.

**Why CI-copy over alternatives**:
| Approach | Pros | Cons | Verdict |
|----------|------|------|---------|
| **CI-copy at Docker build** | Simple, no runtime deps, works offline, reproducible | Must rebuild image to update knowledge | **Phase 1 choice** |
| **Git submodule** | Versioned together, git-native | Submodule UX pain, CI complexity | Viable alternative |
| **NPM package** | Standard JS tooling, semver | Publishing overhead, slow updates | Over-engineered for Phase 1 |

**Dockerfile addition**:
```dockerfile
# Knowledge corpus from loa-dixie (pinned to tag or commit)
ARG DIXIE_REF=main
ADD https://github.com/0xHoneyJar/loa-dixie/archive/${DIXIE_REF}.tar.gz /tmp/dixie.tar.gz
RUN tar -xzf /tmp/dixie.tar.gz -C /tmp && \
    cp -r /tmp/loa-dixie-*/knowledge /app/grimoires/oracle-dixie && \
    cp -r /tmp/loa-dixie-*/persona /app/grimoires/oracle-persona && \
    rm -rf /tmp/dixie.tar.gz /tmp/loa-dixie-*
```

**Source path migration**: loa-finn's `sources.json` (currently in `grimoires/oracle/`) is replaced by the loa-dixie version. The config path in `src/config.ts` points to the build-time-copied location.

**CI-fetch with checksum verification (Flatline SKP-003)**: The GitHub fetch happens in a **CI step before the Docker build**, not inside the Dockerfile. The CI pipeline: (1) fetches the loa-dixie archive at the pinned `DIXIE_REF`, (2) computes SHA-256 of the archive, (3) optionally verifies against a checked-in `dixie-corpus.sha256` manifest, (4) extracts knowledge files into the Docker build context, (5) Docker build copies from build context (no network dependency). If the fetch fails, CI fails fast with a clear error. The Dockerfile `COPY` replaces the `ADD` — no outbound network access during image construction.

**Sync failure semantics (Flatline IMP-001)**: When the CI fetch fails (GitHub outage, rate limit, network error), the pipeline MUST fail fast with a clear error ("DIXIE_REF fetch failed: {HTTP status}"). There is no stale-cache fallback in CI — if you can't get the corpus, you don't ship. For local development only, a `DIXIE_FALLBACK_LOCAL=true` flag allows using a previously-fetched local copy with a WARN log.

**Reproducibility & freshness policy (GPT-5.2 SKP-003)**:

Production builds MUST pin `DIXIE_REF` to an **immutable commit SHA** (not `main`). The `main` default is for local development only. CI enforces this: if `DIXIE_REF` matches a branch name (not a 40-char hex SHA or a semver tag), the production build fails.

Freshness is checked as a **separate CI job** (not inside the Docker build). A scheduled GitHub Action (daily) compares the pinned `DIXIE_REF` in the Dockerfile against loa-dixie HEAD. If the pinned ref is >7 days behind HEAD, the job opens a PR to bump `DIXIE_REF` with a changelog of new sources. This keeps freshness enforcement out of the build path and avoids network dependencies during image construction.

The built image embeds provenance metadata as labels: `dixie.ref`, `dixie.commit`, `build.timestamp`. The `/health` endpoint surfaces `knowledge_dixie_ref` for runtime verification.

**Acceptance Criteria**:
- [ ] Dockerfile fetches loa-dixie knowledge at build time (pinned to commit SHA or semver tag)
- [ ] `DIXIE_REF` build arg defaults to `main` for dev; CI rejects branch names for production builds
- [ ] Knowledge sources available at expected path inside container
- [ ] `sources.json` from loa-dixie is used (not a duplicate in loa-finn)
- [ ] `grimoires/oracle/` in loa-finn is removed or replaced with a README pointing to loa-dixie
- [ ] CI validates: knowledge sources load successfully in built container
- [ ] Separate CI job checks freshness (pinned ref vs HEAD) and opens bump PR when stale (>7 days)
- [ ] Docker image labels include `dixie.ref`, `dixie.commit`, `build.timestamp`
- [ ] `/health` endpoint reports `knowledge_dixie_ref`

---

### FR-5: Oracle Frontend (`oracle.arrakis.community`)

A chat interface that makes the Oracle accessible to anyone with a browser. This is the first dNFT website — the template for all future finnNFT web presences.

**Technology**: Next.js (static export + API route for SSR if needed). Deployed to S3 + CloudFront with a clean migration path to Cloudflare Pages.

**Code location & deployment ownership (GPT-5.2 SKP-005)**: The frontend code lives in the **loa-dixie repository** under a `site/` directory (`loa-dixie/site/`). This co-locates the knowledge corpus, persona, and product UI in one repo — the Oracle's "everything" repository. Deployment pipeline: GitHub Actions in loa-dixie builds the Next.js static export on merge to `main` and uploads to S3. AWS auth uses **OIDC federation** (GitHub Actions → IAM role `dixie-site-deploy` with least-privilege S3 PutObject + CloudFront InvalidateCache). The loa-finn repo is NOT involved in frontend deployment — it only serves the API. Artifact boundary: loa-dixie owns `oracle.arrakis.community` (static site); loa-finn owns `finn.arrakis.community` (API).

**Core features**:
1. **Chat interface**: Text input, streaming response display, conversation history (client-side only for Phase 1)
2. **Source attribution panel**: Collapsible section showing which knowledge sources informed each response, with token counts
3. **Abstraction level hint**: Optional selector (Technical / Product / Cultural / All) that prepends a context hint to the question
4. **Rate limit feedback**: Clear messaging when public tier limit reached ("5 questions/day — come back tomorrow or get a token")
5. **Oracle identity**: Dixie Flatline branding, personality consistent with persona definition

**Design constraints**:
- Mobile-responsive (chat UIs are commonly used on phones)
- Dark mode default (consistent with web3 aesthetic)
- No framework lock-in beyond Next.js (no heavy component libraries)
- Static export where possible (S3-friendly), API routes only if SSR required

**Migration path to Cloudflare Pages**:
The frontend is a static Next.js export served from S3+CloudFront. Migrating to Cloudflare Pages requires:
1. Point DNS CNAME from CloudFront to Cloudflare Pages
2. Deploy the same static build to Cloudflare Pages
3. Remove CloudFront distribution and S3 bucket
No code changes required. The API calls go to `finn.arrakis.community` regardless of where the frontend is hosted.

**Acceptance Criteria**:
- [ ] Next.js app with chat interface, source attribution, abstraction level selector
- [ ] Deployed to S3 + CloudFront at `oracle.arrakis.community`
- [ ] Calls `POST https://finn.arrakis.community/api/v1/oracle` for queries
- [ ] Loading state while response generates (non-streaming for Phase 1; see FR-2 streaming protocol)
- [ ] Source attribution panel shows source IDs, tags, and token counts per response
- [ ] Rate limit error (429) displayed as user-friendly message
- [ ] Mobile-responsive, dark mode default
- [ ] Lighthouse performance score ≥ 90
- [ ] No client-side secrets (API calls go through the API, not directly to model providers)

---

### FR-6: DNS & Infrastructure (Reusable Subdomain Platform)

Terraform configuration for `oracle.arrakis.community` that serves as a reusable module for future dNFT subdomains.

**Infrastructure components**:

| Resource | Purpose | Terraform Resource |
|----------|---------|-------------------|
| S3 bucket | Static site hosting | `aws_s3_bucket.dixie_frontend` |
| CloudFront distribution | CDN + HTTPS | `aws_cloudfront_distribution.dixie` |
| ACM certificate | TLS for `oracle.arrakis.community` | `aws_acm_certificate.dixie` (or wildcard `*.arrakis.community`) |
| Route 53 record | DNS CNAME → CloudFront | `aws_route53_record.dixie` |
| ALB listener rule | API routing for `finn.arrakis.community` | Already exists in `finn.tf:373-387` |

**Reusability design**: The Terraform should be structured as a module that accepts:
```hcl
module "dNFT_website" {
  source      = "./modules/dnft-site"
  subdomain   = "oracle"           # → oracle.arrakis.community
  zone_id     = data.aws_route53_zone.arrakis.zone_id
  domain      = "arrakis.community"
  s3_bucket   = "oracle-site-${var.environment}"
  # Future: custom_domain = "dixie.xyz"  # optional CNAME alias
}
```

Adding the next dNFT website = one more `module` block with a different `subdomain`.

**Wildcard certificate recommendation**: Instead of per-subdomain ACM certs, request `*.arrakis.community` wildcard cert once. All future subdomains are covered automatically.

**Acceptance Criteria**:
- [ ] Terraform module at `deploy/terraform/modules/dnft-site/` (S3 + CloudFront + Route 53)
- [ ] Module parameterized by subdomain name (supports N dNFT sites)
- [ ] `oracle.arrakis.community` deployed using the module
- [ ] ACM wildcard cert for `*.arrakis.community` (or per-subdomain if wildcard has complications)
- [ ] CloudFront serves S3 content with HTTPS
- [ ] CORS configured: CloudFront → `finn.arrakis.community` API
- [ ] CI/CD: GitHub Actions deploys to S3 on merge to main (loa-dixie repo)

---

### FR-7: Backward Compatibility (Inherited from Phase 0)

All Phase 0 backward compatibility guarantees remain in force.

**Acceptance Criteria**:
- [ ] Existing `/api/v1/invoke` requests without `agent: "oracle"` work unchanged
- [ ] New `/api/v1/oracle` endpoint does not interfere with existing routes
- [ ] Existing test suite passes without modification after PR #75 merge

---

## 5. Technical & Non-Functional Requirements

### NFR-1: Performance

| Metric | Target |
|--------|--------|
| Frontend time-to-interactive | < 2s (static site from CDN) |
| Oracle API response (complete) | < 15s p95 (non-streaming; model inference dominates) |
| Oracle concurrency (Flatline IMP-010) | Max 3 concurrent Oracle requests per ECS task. Excess requests receive HTTP 429 with `Retry-After` header. Prevents Oracle traffic from starving non-Oracle invoke requests on the shared ECS service. Configurable via `FINN_ORACLE_MAX_CONCURRENT` env var. |
| Knowledge retrieval overhead | < 100ms (cached, local files) |
| CloudFront cache hit ratio | > 80% for static assets |

### NFR-2: Security

| Concern | Approach |
|---------|----------|
| API authentication | Public tier: IP rate limit via Redis. Authenticated: Bearer token validated in middleware. |
| CORS | `oracle.arrakis.community` origin only (plus localhost for dev) |
| Knowledge injection | Phase 0 trust boundary + 5-gate loader (inherited) |
| Frontend secrets | None — all API calls go through the backend, no client-side API keys |
| Rate limiting | Redis-backed, per-IP for public, per-token for authenticated |
| Rate limit Redis failure mode (Flatline IMP-003) | **Fail-closed**: If Redis is unreachable, the Oracle API returns HTTP 503 (not 200). Rationale: fail-open on a public endpoint with expensive model inference behind it is a denial-of-wallet risk. The health endpoint reports `rate_limiter_healthy: true/false`. CloudWatch alarm triggers if Redis is unreachable for >60s. |
| S3 bucket | Private, CloudFront OAI (Origin Access Identity) only |
| Browser security headers (Flatline IMP-004) | CloudFront response header policy: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://finn.arrakis.community; frame-ancestors 'none'`, `Strict-Transport-Security: max-age=31536000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`. CSP tuned to allow API calls to finn subdomain only. |
| UI rendering safety (GPT-5.2 SKP-006) | **Non-negotiable rule**: The UI renders only source IDs, tags, and token counts in the attribution panel — no raw knowledge excerpts in Phase 1. Model-generated `answer` text is rendered as **sanitized markdown** with HTML tags stripped (no `dangerouslySetInnerHTML`, no raw HTML passthrough). An automated test injects a malicious payload (`<script>alert(1)</script>`) in a knowledge source and confirms it cannot execute in the browser DOM. This prevents XSS at the product boundary even though the model boundary (trust envelope) is already protected by Phase 0. |

### NFR-3: Observability

| Signal | Implementation |
|--------|---------------|
| Phase 0 signals | Inherited: `knowledge_sources_used`, `knowledge_retrieval_ms`, `knowledge_tokens_used` in API response |
| Oracle API metrics | Request count, latency p50/p95/p99, rate limit hits, error rates |
| Frontend monitoring | CloudFront access logs, Lighthouse CI, error tracking (lightweight — Sentry or similar) |
| Knowledge freshness | Startup log of source ages, warn if any source exceeds `max_age_days` |

### NFR-4: Cost

| Resource | Estimated Monthly Cost |
|----------|----------------------|
| S3 (static site, < 100MB) | < $1 |
| CloudFront (low traffic initially) | < $5 |
| ACM certificate | Free |
| Route 53 record | < $1 |
| ECS (Oracle runs inside existing finn task) | $0 incremental |
| Redis (rate limiting, existing instance) | $0 incremental |
| **Total incremental cost** | **< $10/mo** |

Model inference costs are borne by the existing loa-finn billing pipeline and are not new infrastructure cost.

---

## 6. Scope & Prioritization

### MVP Sprint Breakdown (Recommended)

| Sprint | Scope | Dependencies |
|--------|-------|-------------|
| **Sprint 1** | FR-1 (Merge PR #75) + FR-4 (Knowledge sync) + FR-2 (Oracle API endpoint) | None — all internal to loa-finn |
| **Sprint 2** | FR-3 (Extended corpus — 12 new sources) + FR-6 (Terraform module + DNS) | Sprint 1 (API must exist for infra validation) |
| **Sprint 3** | FR-5 (Frontend) + integration testing + deploy | Sprint 1-2 (API + infra must exist) |

### Out of Scope (Explicit)

- Smart contract development (dNFT minting, token economics)
- New model provider integrations (uses existing Hounfour adapters)
- `0xhoneyjar.xyz` domain setup (using `arrakis.community` for speed)
- Session-based conversations (API designed for it, not implemented)
- User registration/accounts (public + manual token issuance for Phase 1)
- Billing integration for Oracle queries (uses existing billing, no new tiers)
- Vector embeddings / semantic search (Phase 2)

---

## 7. Risks & Dependencies

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Knowledge sync drift (dixie HEAD ≠ deployed) | Medium | Medium | `DIXIE_REF` pinning in Dockerfile; CI warns if >7 days behind HEAD |
| Wildcard cert complications | Low | Medium | Fall back to per-subdomain cert; ACM validation is automated via Route 53 |
| Frontend scope creep | Medium | Medium | Phase 1 UI is deliberately minimal — chat + sources + level selector. No auth UI, no dashboards. |
| Rate limiting bypass | Low | Low | IP-based is imperfect; acceptable for Phase 1. Token-based available for authenticated tier. |
| Corpus quality at 20+ sources | Medium | Medium | Each source curated with provenance; gold-set test suite validates selection accuracy |
| CloudFront → Cloudflare Pages migration friction | Low | Low | Frontend is a static Next.js export; no CloudFront-specific features used |

### Dependencies

| Dependency | Status | Risk |
|-----------|--------|------|
| PR #75 (Oracle engine) | Ready to merge (all gates passed) | None — merge is step 1 |
| arrakis Route 53 zone | Exists (`arrakis.community`) | None |
| arrakis ECS cluster | Exists (finn service running) | None |
| arrakis Redis | Exists (ElastiCache) | None — rate limiting reuses it |
| loa-dixie repo | Exists (17 files, 10 sources, persona, RFC) | None |
| ACM wildcard cert | Must be requested | Low — automated validation via Route 53 |
| loa-dixie CI/CD | Must be created (GitHub Actions → S3) | Low — standard pattern |

---

## 8. Architecture Decision Record

### ADR-1: BFF Pattern for Oracle API

**Decision**: Add `/api/v1/oracle` as a Backend-for-Frontend wrapper over the existing invoke endpoint.

**Context**: The invoke endpoint is a multi-agent routing API. Its request/response format is designed for programmatic consumers (other services, CLI tools). A product needs a simpler contract.

**Rationale**: Netflix, Spotify, and Stripe all separate product-facing APIs from internal service APIs. The BFF pattern gives the Oracle its own request/response contract without duplicating the invoke pipeline. The Oracle API is a 50-line Hono route that reshapes requests and responses.

**Consequences**: Two endpoints serve Oracle queries (`/api/v1/invoke` and `/api/v1/oracle`). The invoke endpoint remains the canonical internal API. The oracle endpoint is the product API. Both use the same enrichment pipeline.

### ADR-2: S3+CloudFront with Cloudflare Pages Migration Path

**Decision**: Host the frontend on S3+CloudFront, designed for zero-code-change migration to Cloudflare Pages.

**Context**: S3+CloudFront stays within the existing AWS+Terraform stack. Cloudflare Pages is cheaper at scale and provides edge-native hosting. We want to move quickly (AWS is set up) but not get locked in.

**Rationale**: The frontend is a static Next.js export. It has no server-side logic that depends on AWS. API calls go to `finn.arrakis.community` regardless of frontend hosting. Migration = DNS change + deploy to Cloudflare Pages + remove CloudFront/S3.

**Consequences**: Slightly higher cost initially (~$5/mo vs ~$0 on Cloudflare Pages free tier). No vendor lock-in. Migration is a 30-minute operation.

### ADR-3: CI-Copy for Knowledge Sync

**Decision**: Copy loa-dixie knowledge into loa-finn Docker image at build time via Dockerfile `ADD`.

**Context**: Three options were evaluated (CI-copy, git submodule, npm package). CI-copy is simplest and avoids runtime network dependencies.

**Rationale**: The knowledge corpus changes infrequently (weekly at most). Rebuilding the Docker image is already the deploy trigger. Pinning `DIXIE_REF` to a tag or commit provides reproducibility. No git submodule UX pain, no npm publishing overhead.

**Consequences**: Knowledge updates require a loa-finn image rebuild. This is acceptable for Phase 1 cadence. Phase 5 (Sovereign) introduces hot-reload for live updates.

### ADR-4: Reusable Terraform Module for dNFT Sites

**Decision**: Structure the Oracle's infrastructure as a Terraform module parameterized by subdomain name.

**Context**: The Oracle is the first dNFT to get its own website. Future dNFTs will need the same pattern: S3 bucket + CloudFront + Route 53 record.

**Rationale**: One module invocation per dNFT. Adding the next dNFT site is a 5-line Terraform block. The wildcard cert (`*.arrakis.community`) means no per-site certificate management.

**Consequences**: Slightly more upfront work to create the module vs. hardcoding Oracle-specific resources. Pays off on the second dNFT site.

---

## 9. The Bigger Picture

Phase 0 built the Oracle's brain (knowledge engine).
Phase 1 gives it a body (API, website, infrastructure).

```
Phase 0: Engine           → "The Oracle can understand"
Phase 1: Product Surface  → "Anyone can ask the Oracle"
Phase 2: Scholar          → "The Oracle gets smarter"
Phase 3: Participant      → "The Oracle joins conversations"
Phase 4: Citizen          → "The Oracle owns itself"
Phase 5: Sovereign        → "The Oracle grows itself"
```

Each phase adds a dimension of agency. Phase 1 is where the Oracle stops being a feature and starts being a product.

The infrastructure is the real deliverable. `oracle.arrakis.community` is the proof. The Terraform module is the platform. Every future dNFT stands on what's built here.

---

*This PRD extends v2.0.0 (Phase 0 — Oracle Knowledge Engine, IMPLEMENTED) into Phase 1 (Librarian — Oracle Product Surface). Phase 0 functional requirements (FR-1 through FR-7 in v2.0.0) are complete in PR #75. Phase 1 functional requirements (FR-1 through FR-7 in this document) build the product on top of the engine. Grounded in: `deploy/terraform/finn.tf` (existing ECS infra), loa-dixie `docs/rfc.md` (product vision), loa-dixie `knowledge/` (10 existing sources), arrakis Route 53 (DNS).*
