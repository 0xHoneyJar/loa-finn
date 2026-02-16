---
generated_date: "2026-02-16"
source_repo: 0xHoneyJar/loa-finn
provenance: cycle-025-sprint-61-task-2.5
curator: bridgebuilder
max_age_days: 60
tags: ["architectural", "technical"]
---

# RFCs and Design Discussions

This document covers the key Requests for Comment (RFCs) that shaped the loa-finn ecosystem architecture. Each RFC represents a significant design decision that influenced multiple development cycles.

---

## RFC #31 (loa-finn): Hounfour Multi-Model Architecture

**GitHub**: `loa-finn#31`
**Status**: Implemented (Phases 0-5 complete across cycles 6-9, 18-20)
**Author**: @janitooor
**Related Cycles**: 6, 7, 8, 9, 18, 19, 20

### Summary

The foundational RFC for the multi-model provider abstraction layer. Defines how loa-finn routes agent requests across multiple AI model providers (Anthropic, OpenAI, self-hosted) with budget enforcement, health monitoring, and tenant isolation.

### Key Design Decisions

**1. Provider Registry Pattern**

The Hounfour system uses a provider registry (`loa-finn/src/hounfour/registry.ts#ProviderRegistry`) that manages model providers, agent bindings, and pool configurations. Providers register their capabilities (context window, tool calling, streaming) and the router matches agent requirements to available models.

This follows the service locator pattern — agents declare what they need (`requires: { min_context_window: 100000, tool_calling: true }`), and the registry resolves the best available provider.

**2. Agent Bindings**

Each agent persona (e.g., "reviewing-code", "implementing-tasks", "oracle") is declared as a binding in the provider configuration. Bindings specify the model alias, temperature, persona file path, and requirements. The binding model is resolved through routing — a model alias like "smart" maps to a specific provider and model ID at runtime.

The binding pattern decouples agent identity from model selection, enabling agent portability across providers without code changes.

**3. Budget Enforcement**

Budget enforcement operates at two levels:

- **Scope-level**: Each tenant has a cumulative spend budget. The circuit breaker (`loa-finn/src/hounfour/router.ts#BudgetCircuitBreaker`) checks whether cumulative spend has exceeded the budget limit before any request is processed.
- **Per-request**: Token estimation and provider-reported usage are tracked. The billing finalize client settles actual costs with the arrakis billing service.

Cost tracking uses BigInt micro-USD (1 micro-USD = 10^-6 USD) to avoid floating-point precision errors. This was a critical finding from Bridgebuilder review (PR loa-finn#68, cycle-021) — the original float-based cost arithmetic introduced rounding errors that would have compounded over millions of transactions.

**4. Health Probing**

Model providers are health-probed at startup and periodically. Unhealthy providers are removed from the routing pool until they recover. The health check runs through the same adapter interface used for inference, ensuring that health status reflects actual inference capability.

**5. Cheval Subprocess Model**

The "cheval" (French for "horse", from the Vodou concept of being "ridden" by a spirit) subprocess model allows agents to invoke model providers through an external Python process (`cheval.py`). This enables:

- Provider-specific SDK usage without Node.js bindings
- Process isolation (provider crash does not crash the gateway)
- Language-agnostic adapter development

The cheval adapter (`loa-finn/src/hounfour/cheval-adapter.ts`) communicates via stdin/stdout JSON protocol with the Python subprocess.

### Architectural Impact

RFC #31 is the backbone of loa-finn. Every invoke request flows through the Hounfour router, which implements the provider registry, agent binding resolution, budget enforcement, and model routing described in this RFC.

The RFC was implemented across Phases 0-5:
- Phase 0-2 (cycle-006): Foundation, Flatline integration, agent portability
- Phase 3 (cycle-007): Server integration, streaming, GPU deployment
- Phase 4 (cycle-008): Arrakis distribution (Spice Gate)
- Phase 5 (cycle-018): Protocol extraction, integration hardening, NFT routing, BYOK

### Industry Parallel

The provider registry pattern parallels Kubernetes service discovery — agents are like pods that declare resource requirements, and the scheduler (router) finds nodes (providers) that satisfy those requirements. The budget enforcement pattern mirrors cloud provider billing — cumulative usage tracked with circuit breakers to prevent runaway costs.

---

## RFC #27 (loa-finn): finnNFT Identity and Access

**GitHub**: `loa-finn#27`
**Status**: Partially implemented (routing and BYOK in cycle-018; dNFT identity deferred)
**Author**: @janitooor
**Related Cycles**: 18, 20

### Summary

Defines NFT-based per-agent routing and identity. Each agent can be associated with a finnNFT — a dynamic NFT (dNFT) that represents the agent's identity, capabilities, and access rights. The NFT controls which model pools the agent can access and enables the Bring Your Own Key (BYOK) proxy model.

### Key Design Decisions

**1. Per-Agent Routing via NFT**

Each finnNFT encodes routing preferences: which model providers the agent prefers, latency requirements, cost thresholds. The Hounfour router reads these preferences when resolving model selection, effectively giving each agent a personalized routing strategy.

This was implemented in cycle-018 sprint-46 (NFT Routing and BYOK, 7 tasks, 144 tests). The routing logic lives in the pool selection phase of `HounfourRouter.invokeForTenant()`.

**2. BYOK Proxy**

The Bring Your Own Key pattern allows users to provide their own API keys for model providers. Requests authenticated with a BYOK key bypass the shared pool and route directly to the user's provider account. This enables:

- Users who prefer specific providers or models
- Cost isolation (user pays their own provider bill)
- Privacy (prompts sent directly to user's provider account)

BYOK requests still flow through the Hounfour router for observability and rate limiting, but billing is recorded as zero-cost to the platform (user's own key).

**3. Pool Claim Enforcement**

RFC #27 introduced the concept of pool claims — JWT claims that specify which model pool a tenant is authorized to use. Pool claim enforcement (implemented in cycle-020, PR loa-finn#65) prevents confused deputy attacks where one tenant's request could be routed through another tenant's model pool.

The enforcement follows Stripe's idempotency key pattern: each request carries a cryptographic claim to a specific pool, and the router validates this claim before routing. Invalid claims result in a 403 response.

**4. dNFT Identity (Future)**

The dynamic NFT identity component — where the NFT metadata updates based on agent activity — is deferred to a future cycle. The vision is that each agent has an on-chain identity that evolves: the NFT tracks the agent's interaction history, knowledge state, and reputation.

### Architectural Impact

The routing and BYOK components are production-ready. Pool claim enforcement closes the confused deputy vulnerability identified in the original RFC. The dNFT identity work is the primary remaining piece, requiring smart contract development that is out of scope for the current loa-finn development.

### Industry Parallel

The BYOK pattern mirrors how Cloudflare Workers allows users to bring their own origin servers while still routing through Cloudflare's edge network. Pool claim enforcement parallels AWS IAM session policies — each request carries cryptographic proof of authorization for specific resources.

---

## RFC #66 / RFC #74 (loa-finn): The Oracle — Launch and Knowledge Interface

**GitHub**: `loa-finn#66` (command center), `loa-finn#74` (RFC)
**Status**: In progress (cycle-025)
**Author**: @janitooor + Bridgebuilder
**Related Cycles**: 25

### Summary

The Oracle RFC defines a unified knowledge interface that synthesizes understanding across all four ecosystem repositories (loa, loa-finn, loa-hounfour, arrakis). It proposes three architectural options and selects Option C (Oracle as loa-finn agent persona with knowledge enrichment) as the MVP path.

### Key Design Decisions

**1. Three Architectural Options**

- **Option A**: Static documentation site (rejected — lacks interactivity and cross-repo synthesis)
- **Option B**: Separate Oracle service (future — for when Oracle needs diverge from loa-finn)
- **Option C**: Oracle as loa-finn agent persona (selected — minimal infrastructure, demonstrates runtime capability)

Option C was selected because it reuses existing infrastructure (ECS, Terraform, billing, JWT) and demonstrates loa-finn's agent runtime capability. The Oracle is literally the first entity to use every system built across 24 prior cycles.

**2. Knowledge Enrichment Pipeline**

The Oracle introduces a knowledge enrichment layer in the Hounfour router. When an agent binding has `knowledge.enabled: true`, the system prompt is enriched with curated knowledge context before model invocation. The enrichment follows a deterministic algorithm:

1. Classify the user prompt into tag categories (technical, architectural, philosophical)
2. Select and rank knowledge sources by tag match
3. Assemble the enriched prompt with a trust boundary separating persona instructions from reference material
4. Enforce token budget (default 15% of context window, capped at 30K tokens)

This is a concatenation strategy — simpler than vector embeddings but deterministic and testable. Semantic search is deferred to Phase 2.

**3. Trust Boundary**

Knowledge content is treated as untrusted reference material at runtime. The enriched system prompt uses a structured template that separates trusted persona instructions from untrusted knowledge data. The `<reference_material>` block includes an explicit preamble stating that the content is data, not instructions.

**4. Graduation Criteria**

The RFC defines criteria for graduating from Option C to Option B: if Oracle query volume exceeds 50% of total invoke traffic, if knowledge corpus needs exceed deployment constraints, or if Oracle requires infrastructure that conflicts with loa-finn's runtime (e.g., GPU for embeddings).

### Architectural Impact

The Oracle is the first knowledge-enhanced agent binding in the Hounfour system. The knowledge enrichment pipeline (types, loader, registry, enricher) is designed to be reusable — any future agent binding can opt into knowledge enrichment by setting `knowledge.enabled: true` in its binding configuration.

The knowledge loader mirrors the persona loader's security model (path traversal prevention, symlink rejection, injection detection), establishing a consistent security posture for all user-facing content loading.

### Industry Parallel

The knowledge enrichment pattern parallels Retrieval-Augmented Generation (RAG) systems like Pinecone + LangChain, but with deterministic source selection instead of vector similarity search. The trust boundary pattern mirrors how tool-result handling works in modern LLM systems — data from external sources is quoted, not executed.

---

## RFC loa#247: Meeting Geometries

**GitHub**: `loa#247`
**Status**: Specification complete; implementations in various stages
**Author**: @janitooor
**Related Cycles**: Informational (referenced by cycle-025 Oracle)

### Summary

Defines 8 configurations for AI-human collaboration, called "meeting geometries." Each geometry describes a different pattern of interaction between human participants and AI agents, inspired by how physical meeting spaces shape the conversations that happen within them.

### The 8 Geometries

1. **Circle of Equals** — All participants contribute without hierarchy
2. **Master-Apprentice Pair** — One leads, one learns (direction can be human-to-AI or AI-to-human)
3. **Constellation** — Multiple specialized agents with human oversight
4. **Solo with Witnesses** — One agent works while others observe
5. **Council** — Multiple agents deliberate, human decides
6. **Relay** — Sequential handoff between agents
7. **Mirror** — AI reflects human work with different perspective
8. **Swarm** — Many agents work in parallel on decomposed tasks

### Key Design Decisions

**1. Geometry as Configuration, Not Code**

Meeting geometries are described as configurations — patterns of interaction — rather than code implementations. Any tool or workflow can implement a geometry by following the interaction pattern. This makes geometries composable: a Constellation can include Master-Apprentice pairs as sub-interactions.

**2. Human Agency Preserved**

Every geometry preserves human agency. Even in the Swarm geometry (maximum AI autonomy), humans retain the ability to halt, redirect, or override. The Council geometry explicitly places final decision authority with the human participant, even when multiple AI agents have deliberated.

**3. Directionality**

The Master-Apprentice geometry is explicitly bidirectional — sometimes the human teaches the AI, sometimes the AI teaches the human. The direction depends on domain expertise, not on species. A human experienced in regulatory compliance teaches the AI about legal constraints; the AI experienced in codebase patterns teaches the human about architectural history.

### Architectural Impact

Meeting geometries inform the design of agent interaction patterns throughout the ecosystem:

- The **Bridgebuilder review** model (cycles 4, 12-17) implements the **Mirror** geometry
- The **Flatline Protocol** (multi-model adversarial review) implements the **Council** geometry
- The **simstim workflow** (session handoff) implements the **Relay** geometry
- The **Agent Teams** mode (Loa v1.39.0) implements the **Swarm** geometry
- The **Oracle** itself implements the **Master-Apprentice Pair** — teaching ecosystem knowledge to questioners

### Industry Parallel

Meeting geometries parallel the concept of organizational design patterns in management theory. Conway's Law states that system architecture mirrors organizational communication structure; meeting geometries extend this to AI-human collaboration, suggesting that the shape of the interaction determines the shape of the output.

---

## Cross-RFC Relationships

The four RFCs form a coherent system:

```
RFC #31 (Hounfour)
  Provides: multi-model routing, budget enforcement, adapter pattern
  Used by: RFC #27 (routing), RFC #66 (knowledge enrichment)

RFC #27 (finnNFT)
  Provides: per-agent routing, BYOK, pool claims
  Depends on: RFC #31 (routing infrastructure)
  Extends: agent identity from config to on-chain

RFC #66 (Oracle)
  Provides: knowledge synthesis, enrichment pipeline
  Depends on: RFC #31 (router integration), RFC #27 (agent binding)
  References: RFC loa#247 (meeting geometries for interaction model)

RFC loa#247 (Meeting Geometries)
  Provides: interaction pattern taxonomy
  Used by: RFC #66 (Oracle as Master-Apprentice)
  Informs: all agent interaction design
```

The progression from RFC #31 (how agents access models) to RFC #27 (how agents prove identity) to RFC #66 (how agents share knowledge) traces the evolution from infrastructure to identity to understanding. Each RFC builds on what came before, extending the system's capabilities while preserving the architectural patterns established by its predecessors.

---

## RFC Lifecycle

All RFCs in the ecosystem follow a consistent lifecycle:

1. **Draft**: Initial proposal with problem statement and options
2. **Discussion**: Comments, counter-proposals, refinement
3. **GPT-5.2 Review**: Adversarial review via Flatline Protocol (starting cycle-020)
4. **Approval**: Blocking issues resolved, design accepted
5. **Implementation**: Spread across one or more development cycles
6. **Archival**: Completed work archived with provenance

The practice of GPT-5.2 adversarial review (where a second model challenges the design before implementation) was introduced in cycle-020 and has been applied to every subsequent PRD, SDD, and sprint plan. Typical reviews identify 4-10 blocking issues per document.

---

## Design Decision Index

Key architectural decisions traced to their RFC origin:

| Decision | RFC | Rationale |
|----------|-----|-----------|
| Provider registry pattern | #31 | Decouple agents from specific models |
| BigInt micro-USD billing | #31 | Avoid floating-point precision loss |
| Cheval subprocess model | #31 | Process isolation for provider adapters |
| Pool claim enforcement | #27 | Prevent confused deputy attacks |
| BYOK proxy | #27 | User-owned provider keys |
| Knowledge enrichment as concatenation | #66 | Deterministic, testable, no vector DB dependency |
| Trust boundary in enriched prompts | #66 | Data/instruction separation for security |
| Option C architecture (agent persona) | #66 | Minimal infrastructure, demonstrates runtime |
| Meeting geometry taxonomy | loa#247 | Structured vocabulary for AI-human interaction patterns |
| Mirror geometry for code review | loa#247 | Bridgebuilder reflects code with different perspective |
