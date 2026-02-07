// src/gateway/dashboard-activity-api.ts — GitHub Activity Feed API (TASK-6.3)
//
// Framework-agnostic HTTP API that exposes recent GitHub mutations from the
// audit trail, grouped by type (comments, reviews, PRs, issue updates).

import { createHash, timingSafeEqual } from "node:crypto"

// ── Dependency interfaces (duck-typed for testability) ────

export interface ActivityRecord {
  id: string
  timestamp: number
  action: string
  target?: { type: string; number: number }
  jobId?: string
  templateId?: string
}

export interface AuditTrailRecord {
  id: string
  timestamp: number
  action: string
  phase: string
  jobId?: string
  templateId?: string
  metadata?: Record<string, unknown>
}

export interface ActivityApiDeps {
  auditTrail: {
    getRecords(opts?: { limit?: number }): AuditTrailRecord[]
  }
  authToken: string
}

// ── Request / Response types (same pattern as cron-api.ts) ──

export interface ApiRequest {
  method: string
  path: string
  headers: Record<string, string>
  body?: unknown
  params?: Record<string, string>
  query?: Record<string, string>
}

export interface ApiResponse {
  status: number
  body: unknown
}

// ── Constants ────────────────────────────────────────────────

const GITHUB_ACTIONS = new Set([
  "add_issue_comment",
  "create_pull_request",
  "create_pull_request_review",
  "update_issue",
  "create_or_update_file",
  "push_files",
  "create_branch",
  "merge_pull_request",
])

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 200

// ── GitHubActivityApi ────────────────────────────────────────

export class GitHubActivityApi {
  private readonly deps: ActivityApiDeps

  constructor(deps: ActivityApiDeps) {
    this.deps = deps
  }

  async handle(req: ApiRequest): Promise<ApiResponse> {
    const method = req.method.toUpperCase()
    const path = req.path

    if (method === "GET" && path === "/api/dashboard/github-activity") {
      const authResult = this.checkAuth(req)
      if (authResult) return authResult
      return this.getActivity(req)
    }

    return { status: 404, body: { error: "Not found", code: "ROUTE_NOT_FOUND" } }
  }

  // ── Auth ──────────────────────────────────────────────────

  private checkAuth(req: ApiRequest): ApiResponse | null {
    const authHeader = req.headers["authorization"] ?? req.headers["Authorization"]
    if (!authHeader?.startsWith("Bearer ")) {
      return { status: 401, body: { error: "Unauthorized", code: "AUTH_REQUIRED" } }
    }

    const token = authHeader.slice(7)
    if (!safeCompare(token, this.deps.authToken)) {
      return { status: 401, body: { error: "Unauthorized", code: "AUTH_INVALID" } }
    }

    return null
  }

  // ── Handler ───────────────────────────────────────────────

  private async getActivity(req: ApiRequest): Promise<ApiResponse> {
    const query = req.query ?? {}
    const requestedLimit = parseInt(query["limit"] ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT
    const limit = Math.min(Math.max(1, requestedLimit), MAX_LIMIT)

    // Fetch all records and filter to GitHub mutations
    const allRecords = this.deps.auditTrail.getRecords()
    const githubRecords = allRecords.filter((r) => GITHUB_ACTIONS.has(r.action))

    // Take most recent N (records assumed newest-first; slice from front)
    const limited = githubRecords.slice(0, limit)

    // Map to ActivityRecord format
    const activities: ActivityRecord[] = limited.map((r) => {
      const record: ActivityRecord = {
        id: r.id,
        timestamp: r.timestamp,
        action: r.action,
      }
      if (r.jobId) record.jobId = r.jobId
      if (r.templateId) record.templateId = r.templateId

      // Extract target from metadata if available
      const meta = r.metadata
      if (meta) {
        const prNumber = meta["pull_number"] ?? meta["pr_number"] ?? meta["pullNumber"]
        const issueNumber = meta["issue_number"] ?? meta["issueNumber"]
        if (typeof prNumber === "number") {
          record.target = { type: "pr", number: prNumber }
        } else if (typeof issueNumber === "number") {
          record.target = { type: "issue", number: issueNumber }
        }
      }

      return record
    })

    // Build summary counts
    const summary = { comments: 0, reviews: 0, pullRequests: 0, issueUpdates: 0, other: 0 }
    for (const a of activities) {
      if (a.action.includes("comment")) summary.comments++
      else if (a.action.includes("review")) summary.reviews++
      else if (a.action.includes("pull_request")) summary.pullRequests++
      else if (a.action.includes("issue")) summary.issueUpdates++
      else summary.other++
    }

    return {
      status: 200,
      body: { activities, summary, total: activities.length },
    }
  }
}

// ── Utility ─────────────────────────────────────────────────

/** Timing-safe string comparison to prevent timing attacks on tokens. */
function safeCompare(a: string, b: string): boolean {
  const bufA = createHash("sha256").update(a).digest()
  const bufB = createHash("sha256").update(b).digest()
  return timingSafeEqual(bufA, bufB)
}
