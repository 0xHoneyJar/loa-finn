// src/hounfour/goodhart/reputation-response.ts — ReputationResponse Schema (SDD §4.2.2, T-2.1)
//
// Versioned internal contract for reputation data from dixie.
// Not a hounfour protocol type — internal to finn.

import { Type, type Static } from "@sinclair/typebox"

export const ReputationResponseSchema = Type.Object({
  version: Type.Literal(1),
  score: Type.Number({ minimum: 0, maximum: 1 }),
  asOfTimestamp: Type.String(), // ISO 8601 UTC or "unknown"
  sampleCount: Type.Integer({ minimum: 0 }),
  taskCohort: Type.Optional(Type.Object({
    routingKey: Type.String(),
    score: Type.Number({ minimum: 0, maximum: 1 }),
    sampleCount: Type.Integer({ minimum: 0 }),
  })),
})

export type ReputationResponse = Static<typeof ReputationResponseSchema>

/**
 * Wrap a bare number (degraded dixie response) into a full ReputationResponse.
 * Decay is skipped for bare numbers since we lack timestamp context.
 */
export function wrapBareNumber(score: number): ReputationResponse {
  return {
    version: 1,
    score: Math.max(0, Math.min(1, score)),
    asOfTimestamp: "unknown",
    sampleCount: 0,
  }
}

/**
 * Validate and normalize a dixie response into a ReputationResponse.
 * Returns null for invalid/unrecognizable responses.
 */
export function normalizeResponse(raw: unknown): ReputationResponse | null {
  if (raw === null || raw === undefined) return null

  // Bare number (degraded mode)
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return wrapBareNumber(raw)
  }

  if (typeof raw !== "object") return null

  const obj = raw as Record<string, unknown>

  // Version check — forward-compat: v > 1 uses known fields only
  if (typeof obj.version === "number" && obj.version >= 1) {
    const score = obj.score
    if (typeof score !== "number" || !Number.isFinite(score)) return null

    return {
      version: 1,
      score: Math.max(0, Math.min(1, score)),
      asOfTimestamp: typeof obj.asOfTimestamp === "string" && !isNaN(Date.parse(obj.asOfTimestamp))
        ? obj.asOfTimestamp : "unknown",
      sampleCount: typeof obj.sampleCount === "number" ? Math.max(0, Math.floor(obj.sampleCount)) : 0,
      ...(obj.taskCohort && typeof obj.taskCohort === "object" ? {
        taskCohort: normalizeTaskCohort(obj.taskCohort as Record<string, unknown>),
      } : {}),
    }
  }

  return null
}

function normalizeTaskCohort(raw: Record<string, unknown>): ReputationResponse["taskCohort"] {
  const routingKey = raw.routingKey
  const score = raw.score
  const sampleCount = raw.sampleCount

  if (typeof routingKey !== "string" || typeof score !== "number" || !Number.isFinite(score)) {
    return undefined
  }

  return {
    routingKey,
    score: Math.max(0, Math.min(1, score)),
    sampleCount: typeof sampleCount === "number" ? Math.max(0, Math.floor(sampleCount)) : 0,
  }
}
