# Hounfour — Multi-Model Orchestration

<!-- AGENT-CONTEXT: name=hounfour, type=module, purpose=Multi-model provider routing with budget enforcement and tool orchestration, key_files=[src/hounfour/router.ts, src/hounfour/orchestrator.ts, src/hounfour/budget.ts, src/hounfour/types.ts, src/hounfour/jwt-auth.ts], interfaces=[HounfourRouter, ToolCallOrchestrator, BudgetEnforcer, S2SJwtSigner, ModelPortBase], dependencies=[jose, @mariozechner/pi-ai], version=1ef38a64bfda4b35c37707c710fc9b796ada7ee5 -->

## Purpose

<!-- provenance: CODE-FACTUAL -->
Hounfour is the multi-model routing and orchestration layer. It resolves model aliases to providers, enforces token budgets, executes tool-call loops, and handles multi-tenant JWT authentication. With 33 source files, it is the largest module in loa-finn (`src/hounfour/router.ts:1`).

## Key Interfaces

### HounfourRouter (`src/hounfour/router.ts`)

<!-- provenance: CODE-FACTUAL -->
The central routing class. Resolves which LLM provider handles a request (`src/hounfour/router.ts:1`).

```typescript
class HounfourRouter {
  async invoke(agent, binding, context, messages, options?): Promise<CompletionResult>
  async invokeForTenant(tenantContext, ...): Promise<CompletionResult>
  async invokeWithTools(agent, binding, context, messages, tools, options?): Promise<CompletionResult>
  async healthCheck(): Promise<ProviderHealthSnapshot>
}
```

<!-- provenance: OPERATIONAL -->
**Resolution order** (line-by-line in `invoke()`):
1. Alias resolution → canonical model name
2. Capability check → model supports required features (tool_calling, vision, streaming)
3. Budget check → downgrade to cheaper model if budget exceeded
4. Availability fallback → next provider in chain if primary unhealthy

### ToolCallOrchestrator (`src/hounfour/orchestrator.ts`)

<!-- provenance: CODE-FACTUAL -->
Executes multi-step tool-call loops with safety limits (`src/hounfour/orchestrator.ts:1`).

```typescript
class ToolCallOrchestrator {
  async invoke(request, port, options?): Promise<OrchestratorResult>
}
```

<!-- provenance: CODE-FACTUAL -->
**Hard limits**: 20 iterations, 120s wall time, 50 total tool calls, 3 consecutive failures abort (`src/hounfour/orchestrator.ts:1`).

### BudgetEnforcer (`src/hounfour/budget.ts`)

<!-- provenance: CODE-FACTUAL -->
Tracks token costs per scope (project, phase, sprint) with circuit breaker protection (`src/hounfour/budget.ts:1`).

<!-- provenance: INFERRED -->
- **Warning**: Emitted when scope reaches configurable threshold
- **Exceeded**: Blocks requests or triggers model downgrade
- **Storage**: Redis (if available) or in-memory
- **Failure mode**: Fails closed — blocks requests on budget uncertainty

### ModelPortBase (`src/hounfour/types.ts`)

<!-- provenance: CODE-FACTUAL -->
Interface for LLM provider adapters (`src/hounfour/types.ts:1`).

```typescript
interface ModelPortBase {
  complete(request: CompletionRequest): Promise<CompletionResult>
  capabilities(): ModelCapabilities
  healthCheck(): Promise<boolean>
}
```

<!-- provenance: INFERRED -->
Extend with `ModelPortStreaming` to add `stream()` async generator support.

## Architecture

<!-- provenance: INFERRED -->
```
Request → HounfourRouter
            ├─→ Alias Resolution (registry.ts)
            ├─→ Budget Check (budget.ts)
            ├─→ Provider Selection
            │     ├─→ NativeAdapter (Claude via Pi SDK)
            │     ├─→ ChevalInvoker (subprocess/sidecar)
            │     └─→ BYOKProxyClient (bring-your-own-key)
            └─→ ToolCallOrchestrator
                  ├─→ Tool Execution Loop
                  └─→ Usage Reporting (usage-reporter.ts)
```

## Configuration

<!-- provenance: OPERATIONAL -->
| Env Var | Default | Purpose |
|---------|---------|---------|
| `MODEL` | `claude-opus-4-6` | Primary LLM model |
| `CHEVAL_MODE` | `subprocess` | Model transport (subprocess/sidecar) |
| `FINN_POOLS_CONFIG` | — | Model pool registry config path |
| `FINN_JWT_ENABLED` | `false` | Enable JWT for `/api/v1/*` |
| `FINN_JWKS_URL` | — | JWKS endpoint for token validation |
| `FINN_S2S_PRIVATE_KEY` | — | ES256 private key for outbound JWT |

## Dependencies

<!-- provenance: CODE-FACTUAL -->
- **Internal**: `src/safety/` (audit trail for tool calls), `src/agent/` (sandbox execution)
- **External**: `jose` (JWT/JWS), `@mariozechner/pi-ai` (Claude SDK)
- **Optional**: Redis (budget persistence, rate limiting, idempotency) (`src/hounfour/budget.ts:1`)

## Known Limitations

<!-- provenance: CODE-FACTUAL -->
- IDX Ensemble strategy is experimental; no Gemini adapter (`src/hounfour/ensemble.ts:1`)
- JWKS cache has 5-minute TTL; stale keys during rotation window (`src/hounfour/jwt-auth.ts:1`)
- Tool-call loop hard limits: 20 iterations, 120s wall time, 50 total calls (`src/hounfour/orchestrator.ts:1`)

<!-- ground-truth-meta: head_sha=689a777 generated_at=2026-02-11T01:12:00Z features_sha=689a777 limitations_sha=689a777 ride_sha=689a777 -->
