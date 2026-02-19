// src/nft/eval/distinctiveness.ts — Distinctiveness Scorer (Sprint 12 Task 12.2)
//
// Measures how distinguishable personality responses are from each other by
// computing pairwise cosine similarity of response embeddings. Lower mean
// similarity = more distinctive personalities.

import type { EmbeddingProvider } from "./providers.js"
import type { EvalResponse } from "./harness.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DistinctivenessResult {
  /** Mean cosine similarity across all evaluated pairs (0-1, lower = more distinct) */
  mean_similarity: number
  /** Minimum similarity found among pairs */
  min_similarity: number
  /** Maximum similarity found among pairs */
  max_similarity: number
  /** Number of personality pairs evaluated */
  pairs_evaluated: number
  /** Per-pair similarity breakdown */
  per_pair: Array<{
    personality_a: string
    personality_b: string
    similarity: number
  }>
}

// ---------------------------------------------------------------------------
// Pure Functions
// ---------------------------------------------------------------------------

/**
 * Compute cosine similarity between two vectors.
 * Returns a value in [-1, 1] where 1 = identical direction, 0 = orthogonal, -1 = opposite.
 * Returns 0 if either vector has zero magnitude.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`)
  }
  if (a.length === 0) return 0

  let dotProduct = 0
  let magnitudeA = 0
  let magnitudeB = 0

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    magnitudeA += a[i] * a[i]
    magnitudeB += b[i] * b[i]
  }

  const denominator = Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB)
  if (denominator === 0) return 0

  return dotProduct / denominator
}

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

/**
 * Score distinctiveness across personality pairs by comparing their response embeddings.
 *
 * For each personality, concatenates all response texts into a single corpus,
 * embeds it, then computes pairwise cosine similarity between all personality pairs.
 *
 * @param responses - All eval responses from a run
 * @param provider - Embedding provider
 * @param maxPairs - Optional limit on number of pairs to evaluate (for large sets)
 * @returns DistinctivenessResult with per-pair and aggregate statistics
 */
export async function scoreDistinctiveness(
  responses: EvalResponse[],
  provider: EmbeddingProvider,
  maxPairs?: number,
): Promise<DistinctivenessResult> {
  // Group responses by personality
  const byPersonality = new Map<string, string[]>()
  for (const r of responses) {
    const existing = byPersonality.get(r.personality_id)
    if (existing) {
      existing.push(r.response_text)
    } else {
      byPersonality.set(r.personality_id, [r.response_text])
    }
  }

  const personalityIds = Array.from(byPersonality.keys())
  if (personalityIds.length < 2) {
    return {
      mean_similarity: 0,
      min_similarity: 0,
      max_similarity: 0,
      pairs_evaluated: 0,
      per_pair: [],
    }
  }

  // Concatenate each personality's responses into a single text for embedding
  const texts = personalityIds.map(id => byPersonality.get(id)!.join(" "))

  // Get embeddings for all personality corpora
  const embeddings = await provider.embed(texts)

  // Compute pairwise similarities
  const per_pair: DistinctivenessResult["per_pair"] = []
  let pairsCount = 0
  const limit = maxPairs ?? Number.MAX_SAFE_INTEGER

  for (let i = 0; i < personalityIds.length && pairsCount < limit; i++) {
    for (let j = i + 1; j < personalityIds.length && pairsCount < limit; j++) {
      const similarity = cosineSimilarity(embeddings[i], embeddings[j])
      per_pair.push({
        personality_a: personalityIds[i],
        personality_b: personalityIds[j],
        similarity,
      })
      pairsCount++
    }
  }

  if (per_pair.length === 0) {
    return {
      mean_similarity: 0,
      min_similarity: 0,
      max_similarity: 0,
      pairs_evaluated: 0,
      per_pair: [],
    }
  }

  const similarities = per_pair.map(p => p.similarity)
  const sum = similarities.reduce((acc, v) => acc + v, 0)

  return {
    mean_similarity: sum / similarities.length,
    min_similarity: Math.min(...similarities),
    max_similarity: Math.max(...similarities),
    pairs_evaluated: per_pair.length,
    per_pair,
  }
}
