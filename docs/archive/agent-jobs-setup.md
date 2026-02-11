# Agent Jobs Setup Guide

> **Archived**: Superseded by `docs/operations.md` (cycle-013).
> No active decisions.

## Overview

Agent Jobs is an autonomous GitHub workflow system driven by a cron scheduler with a 14-layer safety stack. It enables Finn to perform scheduled operations on GitHub repositories -- reviewing pull requests, triaging issues, drafting PRs from labeled issues, and cleaning up stale items -- without manual intervention.

Every GitHub mutation passes through a firewall enforcement pipeline, is recorded in a tamper-evident audit trail, and can be halted instantly via a kill switch.

## Prerequisites

- Node.js 22+
- A GitHub App with appropriate permissions (see below)
- Finn gateway running (`pnpm dev` or production deployment)
- Filesystem with reliable `O_EXCL` and `rename()` semantics (ext4, APFS, btrfs -- not NFS or CIFS)

## GitHub App Setup

1. Go to **GitHub Settings > Developer settings > GitHub Apps > New GitHub App**.

2. Configure the app with these repository permissions:

   | Permission          | Access       | Purpose                              |
   |---------------------|--------------|--------------------------------------|
   | Issues              | Read & Write | Triage, label, comment on issues     |
   | Pull requests       | Read & Write | Review PRs, create draft PRs         |
   | Contents            | Read & Write | Read files, push to feature branches |
   | Metadata            | Read         | Repository metadata resolution       |

3. Do **not** grant these permissions (the boot validator rejects them):
   - Administration
   - Organization administration

4. Generate a private key (PEM format) and download it.

5. Install the app on the target repository or organization.

6. Note the following values from the app settings page:
   - **App ID** (numeric, shown at the top of the app page)
   - **Installation ID** (visible in the URL after installing: `https://github.com/settings/installations/<ID>`)

## Configuration

### Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `GITHUB_TOKEN` | GitHub App installation token (`ghs_...`) | Yes | -- |
| `ANTHROPIC_API_KEY` | Anthropic API key for agent reasoning | Yes | -- |
| `AGENT_JOBS_ADMIN_TOKEN` | Bearer token for dashboard and API auth | Yes (auto-generated if not set) | -- |
| `AGENT_JOBS_BIND` | Bind address for the gateway | No | `0.0.0.0` |
| `PORT` | Gateway port | No | `3000` |
| `DATA_DIR` | Base directory for job data, locks, and audit trail | No | `./data` |
| `MODEL` | Claude model for agent reasoning | No | `claude-opus-4-6` |
| `THINKING_LEVEL` | Reasoning depth (`low`, `medium`, `high`) | No | `medium` |

### Token Requirements

The system validates token type at boot:

- **Autonomous mode** requires a GitHub App token (prefix `ghs_`). Personal access tokens (`ghp_`, `github_pat_`) are rejected.
- The boot validator detects token type automatically and fails fast with error code `E_TOKEN_TYPE` if the wrong type is provided.

### Data Directory Structure

```
data/
  jobs/
    <jobId>/
      .lock              # O_EXCL concurrency lock
  runs/
    <jobId>.jsonl        # Append-only run history
  agent-jobs-registry.json  # Job definitions + kill switch state
  audit-trail.jsonl      # Hash-chained audit records
  .kill-switch           # Touch file for emergency stop
```

## Job Templates

Four built-in templates define what each job does:

### pr-review

Automated code review on open pull requests. The agent reads PR diffs, file contents, and existing comments, then posts a structured review.

- **Allowed tools:** `get_pull_request`, `get_pull_request_files`, `get_pull_request_comments`, `list_pull_requests`, `get_file_contents`, `create_pull_request_review`
- **Constraint:** Reviews are advisory (no merge capability)

### issue-triage

Classifies and labels open issues based on content analysis.

- **Allowed tools:** `list_issues`, `get_issue`, `search_issues`, `update_issue`, `add_issue_comment`
- **Use case:** Auto-label `bug`, `feature`, `question`; add triage comments

### pr-draft

Generates draft pull requests from issues labeled with a trigger label (e.g., `agent:draft`).

- **Allowed tools:** `get_issue`, `get_file_contents`, `search_code`, `create_branch`, `create_or_update_file`, `push_files`, `create_pull_request`
- **Constraint:** `create_pull_request` enforces `draft: true`
- **Constraint:** File writes restricted to branches matching `^(finn/|feature/|fix/|chore/)`

### stale-cleanup

Labels stale issues and PRs that have had no activity for a configurable period.

- **Allowed tools:** `list_issues`, `list_pull_requests`, `update_issue`, `add_issue_comment`
- **Use case:** Add `stale` label, post reminder comment

## Schedule Syntax

Jobs support three schedule formats:

| Kind | Syntax | Example |
|------|--------|---------|
| Cron | Standard cron expression | `0 9 * * 1-5` (weekdays at 9 AM) |
| Interval | `<number><unit>` (s/m/h/d) | `30m`, `6h`, `1d` |
| One-time | ISO 8601 datetime | `2026-03-01T09:00:00Z` |

## Job Configuration

Each job accepts these runtime limits:

```json
{
  "id": "review-prs-daily",
  "name": "Daily PR Review",
  "templateId": "pr-review",
  "schedule": { "kind": "cron", "expression": "0 9 * * 1-5" },
  "enabled": true,
  "oneShot": false,
  "concurrencyPolicy": "skip",
  "config": {
    "maxToolCalls": 50,
    "maxRuntimeMinutes": 30,
    "maxItems": 10
  }
}
```

**Concurrency policies:**

| Policy | Behavior |
|--------|----------|
| `skip` | If the job is already running, skip this invocation |
| `queue` | Queue the invocation for later |
| `replace` | Cancel the running invocation and start a new one |

## Safety Stack (14 Layers)

Every tool invocation passes through these layers, in order:

| # | Layer | Module | Purpose |
|---|-------|--------|---------|
| 1 | Default-deny tool registry | `safety/tool-registry.ts` | Only known tools can execute; unknown tools are rejected at boot |
| 2 | GitHub API firewall | `safety/github-firewall.ts` | 9-step enforcement pipeline for every tool call |
| 3 | Action policy per template | `github-firewall.ts` (templatePolicy) | Allow/deny lists scoped to each job template |
| 4 | Dry-run interceptor | `cron/dry-run.ts` | Write tools return simulated success without calling GitHub |
| 5 | Parameter constraints | `safety/tool-registry.ts` (validateParams) | `must_be`, `pattern`, and `allowlist` rules on tool parameters |
| 6 | Rate limiting (GitHub API) | `cron/rate-limiter.ts` | Token bucket: 500/hr global, 100/hr per job; exponential backoff |
| 7 | Circuit breaker per job | `cron/circuit-breaker.ts` | Opens after 5 failures; 30-min cooldown; half-open probe |
| 8 | Kill switch | `cron/kill-switch.ts` | Four activation methods; stops all running jobs immediately |
| 9 | Concurrency manager | `cron/concurrency.ts` | O_EXCL file locks prevent duplicate job runs |
| 10 | Audit trail with HMAC chain | `safety/audit-trail.ts` | Hash-chained JSONL with optional HMAC-SHA256 signing |
| 11 | Secret redaction | `safety/secret-redactor.ts` | Strips GitHub tokens, AWS keys, API keys from logs |
| 12 | Dashboard auth (RBAC) | `gateway/dashboard-auth.ts` | Bearer token + role-based access (viewer/operator) |
| 13 | CSRF protection | `gateway/csrf.ts` | Double-submit cookie for browser-based dashboard |
| 14 | Boot validation | `safety/boot-validation.ts` | 7-step startup check: token, permissions, filesystem, PID, self-test |

### Admin Tools Are Always Denied

Tools classified as `admin` capability (`merge_pull_request`, `delete_branch`, `update_branch_protection`) are unconditionally denied by the firewall (step 1 of the enforcement pipeline). This is not configurable.

## Dashboard

The dashboard provides read-only visibility and operator controls for the agent jobs system.

### API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/dashboard/overview` | Bearer | System health, job counts, 24h run stats, rate limits, audit integrity |
| `GET` | `/api/dashboard/audit` | Bearer | Paginated audit trail with filters (`?job=`, `?template=`, `?action=`, `?from=`, `?to=`) |
| `GET` | `/api/dashboard/audit/verify` | Bearer | Hash chain integrity verification |
| `GET` | `/api/dashboard/github-activity` | Bearer | Recent GitHub mutations grouped by type |
| `GET` | `/api/cron/jobs` | None | List all registered jobs |
| `POST` | `/api/cron/jobs` | Bearer | Create a new job |
| `PATCH` | `/api/cron/jobs/:id` | Bearer | Update job configuration |
| `DELETE` | `/api/cron/jobs/:id` | Bearer | Delete a job |
| `POST` | `/api/cron/jobs/:id/trigger` | Bearer | Manually trigger a job run |
| `GET` | `/api/cron/jobs/:id/logs` | None | Paginated run history for a job |
| `POST` | `/api/cron/kill-switch` | Bearer | Activate or deactivate the kill switch |

### Authentication Model

- **Viewer role:** Read-only endpoints. Localhost requests bypass auth when bound to `127.0.0.1`.
- **Operator role:** Mutating endpoints. Always requires a valid `Authorization: Bearer <token>` header.

### Rate Limiting

Dashboard API endpoints are rate-limited at 60 requests per minute per IP address. Response headers include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`.

### Overview Response Shape

```json
{
  "status": "healthy | degraded | stopped",
  "killSwitch": false,
  "jobs": { "total": 4, "enabled": 3, "running": 1, "circuitOpen": 0 },
  "last24h": {
    "runsTotal": 12,
    "runsSucceeded": 11,
    "runsFailed": 1,
    "githubHttpRequests": 87,
    "githubMutations": 15,
    "itemsProcessed": 23
  },
  "rateLimits": { "githubRemaining": 412, "githubResetAt": "2026-02-07T10:00:00Z" },
  "auditIntegrity": { "lastVerified": "...", "chainValid": true, "totalRecords": 1042 },
  "circuitBreakers": [{ "jobId": "...", "state": "closed", "failures": 0, "lastFailureAt": null }]
}
```

## Kill Switch

The kill switch immediately stops all running jobs and prevents new jobs from starting. It can be activated through four methods:

| Method | How |
|--------|-----|
| **API** | `POST /api/cron/kill-switch` with body `{ "action": "activate" }` |
| **Touch file** | Create `data/.kill-switch` (the service checks for its existence) |
| **Registry flag** | Set `killSwitch: true` in `agent-jobs-registry.json` |
| **In-memory** | Programmatic call to `killSwitch.activate()` |

To deactivate, send `POST /api/cron/kill-switch` with body `{ "action": "deactivate" }`. This removes the touch file, clears the memory flag, and updates the registry.

**Recovery:** If the process restarts while the kill switch file exists, the file is detected on the next `isActive()` check and the memory flag is re-synced automatically.

## Alert Channels

When safety events occur (firewall denials, stuck jobs, stale locks, circuit breaker trips), the alert service routes notifications based on severity:

| Severity | Default channels |
|----------|-----------------|
| Critical | GitHub Issue + Webhook + Console log |
| Error | GitHub Issue + Console log |
| Warning | Webhook + Console log |
| Info | Console log |

Alerts are deduplicated within a 15-minute window to prevent alert storms.

## Sandbox Policies

Cron job sessions run under restricted bash and network policies:

**Allowed bash commands:**
- `git` (read-only: `log`, `show`, `diff`, `status`, `ls-files`, `blame`, `rev-parse`, `branch`)
- `ls`, `cat`, `wc`, `head`, `tail`, `grep`, `find`
- `npm` and `pnpm` (`install`, `test`, `run` -- no `-g`/`--global`)

**Blocked:**
- `gh` CLI (all GitHub access must go through MCP tools for auditability)
- `curl`, `wget` (all HTTP must go through MCP tools)
- Direct access to `api.github.com`, `github.com`, `*.github.com`

## Troubleshooting

### Boot fails with E_TOKEN_MISSING

The `GITHUB_TOKEN` environment variable is not set. Ensure it contains a valid GitHub App installation token.

### Boot fails with E_TOKEN_TYPE

Autonomous mode requires a GitHub App token (prefix `ghs_`). Personal access tokens are not accepted. Generate an installation token from your GitHub App.

### Boot fails with E_FS_CAPABILITY

The data directory is on an unsupported filesystem (NFS, CIFS). Agent Jobs requires local filesystem semantics for `O_EXCL` lock atomicity. Use a local volume.

### Boot fails with E_PID_CONFLICT

Another Finn instance is running (same PID file). Stop the other instance or remove the stale PID file at the path shown in the error message.

### Boot fails with E_SELF_TEST

The firewall self-test failed. Check the audit trail file for corruption. If the file is corrupted, rename or remove it to allow a fresh chain.

### Jobs stuck in "running" state

The stuck job detector runs every tick (15 seconds). Jobs running longer than 2 hours are automatically marked as `stuck`, their CAS token is released, and an alert is fired. To manually recover, restart the service -- stale locks older than 1 hour are broken on startup.

### Circuit breaker is open

A job's circuit breaker opens after 5 failures within a rolling 1-hour window. It remains open for 30 minutes, then transitions to half-open for 2 probe attempts. If probes succeed, the circuit closes. If they fail, it reopens.

To manually reset, update the job via the API:

```bash
curl -X PATCH http://localhost:3000/api/cron/jobs/<jobId> \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"circuitBreaker": {"state": "closed", "failures": 0, "successes": 0}}'
```

### Rate limit exhaustion

The global bucket holds 500 tokens, refilling at 500/hour. Per-job buckets hold 100 tokens at 100/hour. If exhausted, the firewall denies tool calls until tokens refill. GitHub `Retry-After` headers are respected automatically with exponential backoff.

### Audit trail verification fails

Run the chain verification endpoint:

```bash
curl http://localhost:3000/api/dashboard/audit/verify \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

If `chainValid` is false, the `brokenAt` field indicates the sequence number where tampering or corruption was detected. The audit file rotates automatically at 10 MB.
