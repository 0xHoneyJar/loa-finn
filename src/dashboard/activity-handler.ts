// src/dashboard/activity-handler.ts — Hono route handler (SDD §3.2)
// Thin bridge between ActivityFeed and HTTP.

import type { Context } from "hono"
import type { ActivityFeed, ActivityFeedQuery } from "./activity-feed.js"

export function createActivityHandler(feed: ActivityFeed | undefined) {
  return async (c: Context) => {
    // 503 when GITHUB_TOKEN not configured
    if (!feed) {
      return c.json(
        { error: "GitHub token not configured", code: "GITHUB_NOT_CONFIGURED" },
        503,
      )
    }

    const query: ActivityFeedQuery = {
      repo: c.req.query("repo") || undefined,
      type: validateType(c.req.query("type")),
      since: validateSince(c.req.query("since")),
      limit: validateLimit(c.req.query("limit")),
      force_refresh: c.req.query("refresh") === "true",
    }

    try {
      const result = await feed.getActivity(query)
      return c.json(result)
    } catch (err) {
      console.error("[dashboard] activity fetch error:", err)
      return c.json(
        { error: "Failed to fetch activity", code: "ACTIVITY_FETCH_FAILED" },
        500,
      )
    }
  }
}

function validateType(
  raw: string | undefined,
): "pr_review" | "issue_comment" | undefined {
  if (raw === "pr_review" || raw === "issue_comment") return raw
  return undefined
}

function validateSince(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const date = new Date(raw)
  if (isNaN(date.getTime())) return undefined
  // Clamp to max 30 days ago
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  if (date < thirtyDaysAgo) return thirtyDaysAgo.toISOString()
  return date.toISOString()
}

function validateLimit(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const n = parseInt(raw, 10)
  if (isNaN(n) || n < 1) return undefined
  return Math.min(n, 500)
}
