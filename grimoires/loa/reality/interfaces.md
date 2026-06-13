# External Integration Interfaces

> Refreshed by `/ride --enriched` 2026-06-08. External systems loa-finn integrates with.

## LLM Providers (via Hounfour + Pi SDK)
- Anthropic Claude (`ANTHROPIC_API_KEY` required at boot), plus GPT / Qwen / Moonshot routed
  through `src/hounfour/router.ts` with alias resolution, fallback, and budget enforcement
  (`CHANGELOG.md` glossary; `src/hounfour/`).

## Sibling service: `arrakis`
- **Inbound**: arrakis-issued JWTs validated via JWKS (`config.jwt`, issuer `arrakis`,
  audience `loa-finn`, `src/hounfour/jwt-auth.ts`).
- **Outbound (S2S)**: signed with `config.s2s` private key (issuer `loa-finn`, audience `arrakis`).
- Oracle CORS default origin `https://oracle.arrakis.community` (`config.ts:347`).

## Object storage: Cloudflare R2 (S3 API)
- `@aws-sdk/client-s3`; `config.r2` (endpoint/bucket/keys). WAL checkpoint sync
  (`src/persistence/`).

## Git archive
- `config.git` remote/branch/archiveBranch (`finn/archive`) for periodic snapshot persistence.

## Blockchain
- **Base** (chainId 8453): SIWE auth + x402 settlement; RPC via Alchemy (`ALCHEMY_API_KEY`,
  `X402_RPC_URLS`).
- **Berachain** (chainId 80094): NFT personality on-chain reads (Mibera ERC-721
  `0x6666...c420`, `config.personality`, `src/nft/on-chain-reader.ts`).

## Redis (optional)
- `ioredis` for circuit breaker, budget, rate limiter, idempotency state (`config.redis`,
  `src/hounfour/redis/`). Lua scripts in `src/x402/lua/`.

## GitHub (BridgeBuilder)
- Automated PR review via `src/bridgebuilder/`; R2-backed run leases; COMMENT-only.

## Observability
- Prometheus `/metrics`; OpenTelemetry OTLP gRPC export (optional, `src/tracing/`).

## Hounfour core types (selected, `src/hounfour/types.ts`)
`ProviderEntry`, `ModelEntry`, `ModelCapabilities`, `CompletionRequest`, `CompletionResult`.
