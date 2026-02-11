# Persistence — WAL, R2, Git Sync

<!-- AGENT-CONTEXT: name=persistence, type=module, purpose=Three-tier durability with write-ahead log and cloud sync, key_files=[src/persistence/wal.ts, src/persistence/r2-storage.ts, src/persistence/git-sync.ts, src/persistence/recovery.ts], interfaces=[WAL, ICheckpointStorage, R2CheckpointStorage, GitSync, runRecovery], dependencies=[@aws-sdk/client-s3], version=1ef38a64bfda4b35c37707c710fc9b796ada7ee5 -->

## Purpose

<!-- provenance: CODE-FACTUAL -->
The persistence module implements a 3-tier durability strategy: local write-ahead log (WAL), Cloudflare R2 cloud checkpoints, and Git archive snapshots. This ensures data survives any single-point failure — similar to PostgreSQL's WAL + checkpoint architecture (`src/persistence/wal.ts:1`).

## Key Interfaces

### WAL (`src/persistence/wal.ts`)

```typescript
class WAL {
  async initialize(): Promise<void>
  async append(entry: WALEntry): Promise<void>
  async truncateAfter(segmentSeq: number): Promise<void>
  async readEntry(seq: number): Promise<WALEntry | null>
  async snapshot(): Promise<WALSnapshot>
  getStatus(): WALStatus
  getMetrics(): WALMetrics
}
```

<!-- provenance: CODE-FACTUAL -->
Entry types (`WALEntryType`): `session`, `bead`, `memory`, `config`. Uses mutex for serialized appends — single-writer only (`src/persistence/wal.ts:1`).

### ICheckpointStorage (`src/persistence/r2-storage.ts`)

```typescript
interface ICheckpointStorage {
  readFile(path: string): Promise<Buffer | null>
  writeFile(path: string, data: Buffer): Promise<void>
  deleteFile(path: string): Promise<void>
  listFiles(prefix: string): Promise<string[]>
  verifyChecksum(path: string, expected: string): Promise<boolean>
  stat(path: string): Promise<FileStat | null>
}
```

<!-- provenance: CODE-FACTUAL -->
`R2CheckpointStorage` implements this via `@aws-sdk/client-s3` for Cloudflare R2 (`src/persistence/r2-storage.ts:1`).

### Recovery (`src/persistence/recovery.ts`)

```typescript
async function runRecovery(config, wal, r2Sync, gitSync): Promise<RecoveryResult>
```

<!-- provenance: CODE-FACTUAL -->
**Recovery cascade**: R2 checkpoint → Git snapshot → local WAL replay. Modes: `strict` (require all tiers), `degraded` (best-effort), `clean` (fresh start) (`src/persistence/recovery.ts:1`).

## Architecture

<!-- provenance: INFERRED -->
```
Application → WAL (local, append-only)
                │
                ├─→ R2Sync (SYNC_INTERVAL_MS, default 30s)
                │     └─→ R2CheckpointStorage (@aws-sdk/client-s3)
                │
                ├─→ GitSync (GIT_SYNC_INTERVAL_MS, default 1h)
                │     └─→ git push to GIT_ARCHIVE_BRANCH
                │
                └─→ WALPruner (after confirmed sync)

Recovery: R2 → Git → WAL (cascade fallback)
```

## Components (10 files)

<!-- provenance: CODE-FACTUAL -->
| File | Responsibility |
|------|---------------|
| `wal.ts` | Append-only WAL with mutex serialization |
| `wal-path.ts` | WAL file path utilities |
| `r2-storage.ts` | `ICheckpointStorage` via S3 SDK |
| `r2-sync.ts` | WAL → R2 checkpoint sync coordination |
| `git-sync.ts` | Snapshot to `GIT_ARCHIVE_BRANCH` |
| `recovery.ts` | Recovery cascade (R2 → Git → WAL) |
| `pruner.ts` | WAL segment cleanup after sync |
| `upstream.ts` | Upstream persistence integration |
| `upstream-check.ts` | Upstream compatibility validation |
| `index.ts` | Barrel exports |

(Reference: `src/persistence/wal.ts:1`)

## Configuration

<!-- provenance: OPERATIONAL -->
| Env Var | Default | Purpose |
|---------|---------|---------|
| `DATA_DIR` | `./data` | WAL storage root |
| `SYNC_INTERVAL_MS` | `30000` | WAL → R2 sync frequency |
| `GIT_SYNC_INTERVAL_MS` | `3600000` | Git archive interval (1h) |
| `R2_ENDPOINT` | — | R2 endpoint URL |
| `R2_BUCKET` | `loa-finn-data` | R2 bucket name |
| `R2_ACCESS_KEY_ID` | — | R2 access key |
| `R2_SECRET_ACCESS_KEY` | — | R2 secret key |
| `GIT_ARCHIVE_BRANCH` | `finn/archive` | Git checkpoint branch |

## Dependencies

<!-- provenance: CODE-FACTUAL -->
- **Internal**: `src/scheduler/` (sync scheduling), `src/config.ts` (configuration)
- **External**: `@aws-sdk/client-s3` (R2 operations), Git CLI (archive snapshots) (`src/persistence/r2-storage.ts:1`)

## Known Limitations

<!-- provenance: CODE-FACTUAL -->
- Single-writer WAL — no concurrent sessions per WAL file (`src/persistence/wal.ts:1`)
- S3 compatibility untested with non-Cloudflare providers (`src/persistence/r2-storage.ts:1`)

<!-- ground-truth-meta: head_sha=689a777 generated_at=2026-02-11T01:12:00Z features_sha=689a777 limitations_sha=689a777 ride_sha=689a777 -->
