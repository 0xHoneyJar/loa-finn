# Bridgebuilder Deployment Guide (Railway)

Bridgebuilder is an autonomous PR review agent. It runs as a scheduled cron job on Railway, reviewing open pull requests across configured GitHub repositories using Claude. This guide covers everything needed to go from zero to production.

---

## Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `GITHUB_TOKEN` | GitHub PAT with `repo` scope, or a GitHub App installation token. Must have read/write access to PRs and repo contents for every repo listed in `BRIDGEBUILDER_REPOS`. | `ghp_xxxxxxxxxxxxxxxxxxxx` |
| `ANTHROPIC_API_KEY` | Anthropic API key from [console.anthropic.com](https://console.anthropic.com). | `sk-ant-api03-xxxxxxxxxxxx` |
| `BRIDGEBUILDER_REPOS` | Comma-separated list of `owner/repo` strings. No spaces. | `0xHoneyJar/loa,0xHoneyJar/bears` |

### Optional (with defaults)

| Variable | Description | Default |
|----------|-------------|---------|
| `BRIDGEBUILDER_MODEL` | Anthropic model ID for reviews. | `claude-sonnet-4-5-20250929` |
| `BRIDGEBUILDER_MAX_PRS` | Maximum number of PRs to review per run. | `10` |
| `BRIDGEBUILDER_MAX_RUNTIME_MINUTES` | Hard time limit per run in minutes. The lease TTL is this value + 5 minutes. | `25` |
| `BRIDGEBUILDER_MAX_FILES_PER_PR` | Skip PRs with more changed files than this. | `50` |
| `BRIDGEBUILDER_MAX_DIFF_BYTES` | Skip PRs whose diff exceeds this byte count. | `100000` |
| `BRIDGEBUILDER_MAX_INPUT_TOKENS` | Max input tokens sent to the model per review. | `8000` |
| `BRIDGEBUILDER_MAX_OUTPUT_TOKENS` | Max output tokens requested from the model per review. | `4000` |
| `BRIDGEBUILDER_RE_REVIEW_HOURS` | If set, re-review PRs that were last reviewed more than this many hours ago. If unset, PRs are not re-reviewed. | (unset) |
| `BRIDGEBUILDER_DIMENSIONS` | Comma-separated review dimensions. | `security,quality,test-coverage` |
| `BRIDGEBUILDER_DRY_RUN` | When `true`, runs the full pipeline but does not post reviews to GitHub. | `false` |
| `BRIDGEBUILDER_DEBUG` | When `true`, emits debug-level logs (individual repo names, full redacted config). | `false` |

### R2 / Lease Variables

These enable the distributed lease mechanism that prevents overlapping runs. If any of these are missing, the lease is skipped and concurrent runs are possible (not recommended in production).

| Variable | Description | Example |
|----------|-------------|---------|
| `R2_ENDPOINT` | Cloudflare R2 S3-compatible endpoint URL. | `https://<account-id>.r2.cloudflarestorage.com` |
| `R2_BUCKET` | R2 bucket name. | `loa-bridgebuilder` |
| `R2_ACCESS_KEY_ID` | R2 access key ID. | `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| `R2_SECRET_ACCESS_KEY` | R2 secret access key. | `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |

---

## Recommended Initial Settings

For the first deployment, use conservative settings:

```
BRIDGEBUILDER_DRY_RUN=true
BRIDGEBUILDER_MAX_PRS=3
```

This lets you verify the full pipeline end-to-end (config validation, preflight, lease acquisition, PR discovery, review generation) without posting anything to GitHub. Promote to production only after confirming healthy logs.

---

## Step-by-Step Deployment

### 1. Create Railway Project

1. Go to [railway.app](https://railway.app) and create a new project.
2. Choose "Deploy from GitHub repo" and select the `0xHoneyJar/loa` repository.
3. Set the root directory to `/` (the Dockerfile is at `deploy/Dockerfile`).
4. Under service settings, set the Dockerfile path to `deploy/Dockerfile`.
5. Configure the service as a **cron job**, not a web service. Bridgebuilder is a batch process that exits after each run.
6. Set the cron schedule. Recommended starting schedule: every 30 minutes (`*/30 * * * *`).

### 2. Configure the Start Command

Override the default CMD to run the Bridgebuilder entry point instead of the main Finn server:

```
node dist/src/bridgebuilder/entry.js
```

### 3. Set Environment Variables

In the Railway service settings, add all required variables and your chosen optional variables. At minimum:

```
GITHUB_TOKEN=ghp_your_token_here
ANTHROPIC_API_KEY=sk-ant-api03-your_key_here
BRIDGEBUILDER_REPOS=0xHoneyJar/loa
BRIDGEBUILDER_DRY_RUN=true
BRIDGEBUILDER_MAX_PRS=3
R2_ENDPOINT=https://your-account.r2.cloudflarestorage.com
R2_BUCKET=loa-bridgebuilder
R2_ACCESS_KEY_ID=your_r2_key
R2_SECRET_ACCESS_KEY=your_r2_secret
```

### 4. Deploy

Trigger a deploy. Railway will build the Docker image using the multi-stage Dockerfile and run the cron on schedule. You can also trigger a manual run from the Railway dashboard to verify immediately.

### 5. Verify (Dry-Run)

Check the deployment logs for the healthy log sequence described in the next section. Confirm:

- All repos pass preflight.
- Lease is acquired (if R2 is configured).
- PRs are discovered and processed.
- No reviews are posted (dry-run mode).
- Lease is released.
- Process exits with code 0.

### 6. Promote to Production

Once dry-run logs look healthy:

1. Set `BRIDGEBUILDER_DRY_RUN=false`.
2. Increase `BRIDGEBUILDER_MAX_PRS` to your desired limit (default is `10`).
3. Redeploy.

---

## Expected Healthy Log Markers

A successful run produces these log lines in order:

```
[bridgebuilder] Starting...
[bridgebuilder] Repos: 2 configured
[bridgebuilder] Dimensions: security, quality, test-coverage
[bridgebuilder] Model: claude-sonnet-4-5-20250929
[bridgebuilder] Dry run: true
[bridgebuilder] Max PRs per run: 3
[bridgebuilder] Max runtime: 25m
[bridgebuilder] Preflight: all 2 repos accessible
[bridgebuilder] Lease acquired: run-1738900000000-a1b2c3
[bridgebuilder] Run complete:
[bridgebuilder]   PRs found:  4
[bridgebuilder]   Reviewed:   3
[bridgebuilder]   Skipped:    1
[bridgebuilder]   Errors:     0
[bridgebuilder]   Tokens:     12000 in / 6000 out
[bridgebuilder]   Duration:   45s
[bridgebuilder] Lease released
```

If there are no open PRs:

```
[bridgebuilder] No open PRs found across 2 repos — nothing to review
```

## Expected Overlap Log Markers

When a second run starts while a lease is still held by a previous run:

```
[bridgebuilder] Starting...
[bridgebuilder] Preflight: all 2 repos accessible
[bridgebuilder] Run lease held by run-1738900000000-a1b2c3 — exiting cleanly
```

The process exits with code 0. This is normal and expected behavior, not an error.

---

## Troubleshooting

### Token Scope Errors (Preflight Failures)

**Symptom**: Process crashes with a message like:

```
Preflight failed: Token lacks access to owner/repo — check repo scope or app installation
```

or:

```
Preflight failed: Repo not found: owner/repo — check spelling
```

**Fix**:

- Verify `GITHUB_TOKEN` has the `repo` scope (for classic PATs) or the correct repository permissions (for fine-grained PATs / GitHub App tokens).
- Verify every entry in `BRIDGEBUILDER_REPOS` is spelled correctly (`owner/repo` format, case-sensitive).
- For GitHub App installation tokens, confirm the app is installed on the target organization and has access to the specific repositories.

### R2 Connection Failures (Lease Not Acquired)

**Symptom**: The `Lease acquired` log line never appears, or an error occurs during lease acquisition.

**Fix**:

- Verify all four R2 variables are set: `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
- Confirm the R2 endpoint URL is correct for your Cloudflare account.
- Confirm the R2 bucket exists and the access key has read/write permission.
- If R2 is intentionally unavailable, the lease step is skipped entirely and runs proceed without overlap protection. This is acceptable for development but not recommended for production.

### Rate Limit Exhaustion

**Symptom**: Log line:

```
[bridgebuilder] Insufficient GitHub API quota (42 remaining, need >= 100) — skipping run
```

The process exits with code 0 and no reviews are posted.

**Fix**:

- This is a safety mechanism, not an error. The run will succeed on the next cron invocation once the GitHub API rate limit resets (hourly).
- If this happens frequently, reduce `BRIDGEBUILDER_MAX_PRS` or increase the cron interval.
- For higher rate limits, use a GitHub App installation token instead of a classic PAT (5000 vs 5000 per hour, but App tokens are scoped per-installation and may have separate limits).

### Stuck Lease After Crash

**Symptom**: Every run logs `Run lease held by run-... — exiting cleanly` even though no run is actually active.

**Fix**:

- The lease has a TTL of `BRIDGEBUILDER_MAX_RUNTIME_MINUTES + 5` minutes (default: 30 minutes). Wait for the TTL to expire and the next run will acquire the lease normally.
- If you cannot wait, manually delete the lease object from R2. The key is `bridgebuilder/run-lock` inside the configured bucket.

---

## Adding or Removing Repos

1. Update the `BRIDGEBUILDER_REPOS` environment variable in Railway. Repos are comma-separated with no spaces:

   ```
   BRIDGEBUILDER_REPOS=0xHoneyJar/loa,0xHoneyJar/bears,0xHoneyJar/new-repo
   ```

2. Ensure the `GITHUB_TOKEN` has access to any newly added repos.
3. Redeploy (Railway redeploys automatically on env var changes, or trigger manually).

The next run will preflight-check all repos and begin reviewing PRs from the updated list.
