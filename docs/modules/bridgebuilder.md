# BridgeBuilder — PR Automation Pipeline

<!-- AGENT-CONTEXT: name=bridgebuilder, type=module, purpose=Automated GitHub PR review with persona injection and R2 lease, key_files=[src/bridgebuilder/entry.ts, src/bridgebuilder/r2-client.ts, src/bridgebuilder/lease.ts], interfaces=[R2Client, RunLease], dependencies=[@aws-sdk/client-s3], version=0.1.0 -->

## Purpose

BridgeBuilder is an automated GitHub PR review pipeline. It runs as a standalone entry point (`npm run bridgebuilder`), claims an R2-backed execution lease to prevent concurrent runs, loads a review persona, and posts review comments on pull requests (`src/bridgebuilder/entry.ts`).

## Key Interfaces

### Entry Point (`src/bridgebuilder/entry.ts`)

Standalone CLI entry — not part of the main HTTP server. Flow:

1. GitHub token bridge → load config → create adapters
2. Acquire R2 run lease (prevents concurrent executions)
3. Load review persona from grimoire
4. Run pipeline on target PRs
5. Post review comments
6. Release lease

### R2Client (`src/bridgebuilder/r2-client.ts`)

```typescript
class R2Client implements IR2Client {
  async get(key): Promise<GetResult | null>
  async put(key, data): Promise<PutResult>
  async delete(key): Promise<void>
  async putIfAbsent(key, data): Promise<ConditionalPutResult>
  async putIfMatch(key, data, etag): Promise<ConditionalUpdateResult>
}
```

Provides conditional operations (`putIfAbsent`, `putIfMatch`) for lease management.

### RunLease (`src/bridgebuilder/lease.ts`)

```typescript
class RunLease {
  async claim(runId): Promise<LeaseToken | null>
  async release(runId, token): Promise<boolean>
}
```

R2-backed distributed lease. Uses `putIfAbsent` to claim, `putIfMatch` (with ETag) to release. Prevents concurrent BridgeBuilder executions.

## Architecture

```
railway.toml (cron: 30min)
  └─→ npm run bridgebuilder
        └─→ entry.ts
              ├─→ R2Client.putIfAbsent (claim lease)
              ├─→ loadConfig() → FinnConfig
              ├─→ Persona Loader (grimoire)
              ├─→ Pipeline.run(targetPRs)
              │     └─→ Review each PR → Post comment
              └─→ R2Client.putIfMatch (release lease)
```

## Configuration

| Env Var | Purpose |
|---------|---------|
| `GITHUB_TOKEN` | GitHub API access for PR reading and commenting |
| `ANTHROPIC_API_KEY` | LLM for review generation |
| `BRIDGEBUILDER_REPOS` | Comma-separated repos to monitor |
| `BRIDGEBUILDER_BOT_USER` | Bot username for activity filtering |
| `R2_*` | R2 credentials for run lease storage |

## Deployment

Deployed via Railway (`railway.toml`) as a cron job running every 30 minutes. Can also run locally:

```bash
npm run bridgebuilder
```

## Dependencies

- **Internal**: `src/config.ts` (configuration), `src/hounfour/` (LLM for reviews)
- **External**: `@aws-sdk/client-s3` (R2 lease storage), GitHub API (PR operations)

## Known Limitations

- Can only COMMENT on PRs — cannot APPROVE or REQUEST_CHANGES (`src/bridgebuilder/entry.ts`)
- R2 lease has no automatic expiry — if the process crashes mid-run, the lease must be manually released
- Fatal errors redact secrets before logging

<!-- ground-truth-meta: head_sha=689a777 generated_at=2026-02-11T01:13:00Z features_sha=689a777 limitations_sha=689a777 ride_sha=689a777 -->
