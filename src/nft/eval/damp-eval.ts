// src/nft/eval/damp-eval.ts — dAMP Behavioral Distinctiveness (Sprint 13 Task 13.1)
//
// Compares response distributions between personality pairs across behavioral
// dimensions derived from the 96-dial dAMP system. Uses Welch's t-test for
// statistical significance testing on text-extracted behavioral features.

import type { EvalResponse } from "./harness.js"
import type { DAMPFingerprint, DAMPDialId } from "../signal-types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DAMPEvalConfig {
  /** Map personality_id -> DAMPFingerprint for comparison */
  fingerprints: Map<string, DAMPFingerprint>
  /** Minimum samples per personality for statistical significance */
  minSamplesPerPersonality?: number // default: 10
}

export interface DAMPDimensionResult {
  /** Dial category prefix (sw, cs, as, cg, ep, cr, cv, mo, et, sc, ag, id) */
  dimension: string
  mean_a: number
  mean_b: number
  p_value: number
  /** Whether p < 0.05 */
  significant: boolean
}

export interface DAMPEvalResult {
  total_pairs: number
  dimensions_with_significant_difference: number
  per_pair: Array<{
    personality_a: string
    personality_b: string
    dimensions: DAMPDimensionResult[]
    significant_count: number
  }>
  /** Target met if >= 5 dimensions with significant difference */
  target_met: boolean
}

// ---------------------------------------------------------------------------
// DAMP Dimension Categories — the 12 category prefixes
// ---------------------------------------------------------------------------

/** The 12 behavioral dimension category prefixes from dAMP-96 */
export const DAMP_DIMENSION_PREFIXES = [
  "sw", "cs", "as", "cg", "ep", "cr", "cv", "mo", "et", "sc", "ag", "id",
] as const

export type DAMPDimensionPrefix = typeof DAMP_DIMENSION_PREFIXES[number]

// ---------------------------------------------------------------------------
// Welch's T-Test Implementation
// ---------------------------------------------------------------------------

/**
 * Compute sample mean.
 */
function mean(arr: number[]): number {
  if (arr.length === 0) return 0
  let sum = 0
  for (let i = 0; i < arr.length; i++) sum += arr[i]
  return sum / arr.length
}

/**
 * Compute sample variance (Bessel's correction: divide by n-1).
 */
function variance(arr: number[]): number {
  if (arr.length < 2) return 0
  const m = mean(arr)
  let sumSq = 0
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i] - m
    sumSq += d * d
  }
  return sumSq / (arr.length - 1)
}

/**
 * Approximate the regularized incomplete beta function I_x(a, b)
 * using a continued fraction expansion (Lentz's algorithm).
 * This is used to compute the CDF of the t-distribution.
 */
function betaIncomplete(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1

  // Use symmetry transformation if x > (a+1)/(a+b+2)
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - betaIncomplete(1 - x, b, a)
  }

  // Compute the log of the front factor
  const lnBeta = logBeta(a, b)
  const front = Math.exp(
    Math.log(x) * a + Math.log(1 - x) * b - lnBeta,
  ) / a

  // Continued fraction (Lentz's method)
  const maxIter = 200
  const eps = 1e-14
  let f = 1
  let c = 1
  let d = 1 - (a + b) * x / (a + 1)
  if (Math.abs(d) < eps) d = eps
  d = 1 / d
  f = d

  for (let m = 1; m <= maxIter; m++) {
    // Even step: d_{2m}
    let numerator = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m))
    d = 1 + numerator * d
    if (Math.abs(d) < eps) d = eps
    c = 1 + numerator / c
    if (Math.abs(c) < eps) c = eps
    d = 1 / d
    f *= c * d

    // Odd step: d_{2m+1}
    numerator = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1))
    d = 1 + numerator * d
    if (Math.abs(d) < eps) d = eps
    c = 1 + numerator / c
    if (Math.abs(c) < eps) c = eps
    d = 1 / d
    const delta = c * d
    f *= delta

    if (Math.abs(delta - 1) < eps) break
  }

  return front * f
}

/**
 * Log of the Beta function: log(B(a, b)) = logGamma(a) + logGamma(b) - logGamma(a+b)
 */
function logBeta(a: number, b: number): number {
  return logGamma(a) + logGamma(b) - logGamma(a + b)
}

/**
 * Stirling's approximation for log(Gamma(x)) — Lanczos approximation.
 */
function logGamma(x: number): number {
  // Lanczos coefficients (g=7, n=9)
  const c = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ]
  const g = 7

  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x)
  }

  x -= 1
  let a = c[0]
  const t = x + g + 0.5
  for (let i = 1; i < c.length; i++) {
    a += c[i] / (x + i)
  }

  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

/**
 * CDF of Student's t-distribution with df degrees of freedom.
 * P(T <= t) where T ~ t(df).
 */
function tDistCDF(t: number, df: number): number {
  const x = df / (df + t * t)
  const ibeta = betaIncomplete(x, df / 2, 0.5)
  const cdf = 1 - 0.5 * ibeta
  return t >= 0 ? cdf : 1 - cdf
}

/**
 * Welch's two-sample t-test (unequal variances).
 * Returns t-statistic and two-tailed p-value.
 * 
 * If either sample has fewer than 2 values, returns { t: 0, p: 1 }.
 */
export function welchTTest(
  a: number[],
  b: number[],
): { t: number; p: number } {
  const n1 = a.length
  const n2 = b.length

  if (n1 < 2 || n2 < 2) return { t: 0, p: 1 }

  const m1 = mean(a)
  const m2 = mean(b)
  const v1 = variance(a)
  const v2 = variance(b)

  const se1 = v1 / n1
  const se2 = v2 / n2
  const seDiff = Math.sqrt(se1 + se2)

  if (seDiff === 0) return { t: 0, p: 1 }

  const t = (m1 - m2) / seDiff

  // Welch-Satterthwaite degrees of freedom
  const numerator = (se1 + se2) * (se1 + se2)
  const denominator =
    (se1 * se1) / (n1 - 1) + (se2 * se2) / (n2 - 1)

  if (denominator === 0) return { t: 0, p: 1 }

  const df = numerator / denominator

  // Two-tailed p-value
  const cdf = tDistCDF(Math.abs(t), df)
  const p = 2 * (1 - cdf)

  return { t, p: Math.max(0, Math.min(1, p)) }
}

// ---------------------------------------------------------------------------
// Behavioral Dimension Extractors
// ---------------------------------------------------------------------------

/** Word lists for heuristic feature extraction */
const WARM_WORDS = new Set([
  "friend", "friends", "friendly", "welcome", "warm", "warmth", "kind",
  "kindness", "love", "loving", "care", "caring", "together", "share",
  "sharing", "gentle", "gentle", "embrace", "hug", "comfort", "cozy",
  "dear", "sweet", "tender", "affection", "compassion", "generous",
  "generous", "heart", "heartfelt", "open", "inviting", "joy", "joyful",
])

const HEDGING_WORDS = new Set([
  "perhaps", "maybe", "possibly", "might", "could", "somewhat", "rather",
  "slightly", "probably", "likely", "unlikely", "uncertain", "unclear",
  "debatable", "arguable", "tentative", "approximately", "roughly",
  "seemingly", "apparently", "allegedly", "supposedly", "conceivably",
  "potentially", "presumably", "it seems", "i think", "in my opinion",
])

const POSITIVE_WORDS = new Set([
  "good", "great", "wonderful", "beautiful", "excellent", "amazing",
  "fantastic", "love", "joy", "happy", "happiness", "delight", "pleasure",
  "hope", "hopeful", "bright", "brilliant", "perfect", "lovely",
  "magnificent", "splendid", "marvelous", "superb", "incredible",
  "outstanding", "blessed", "grateful", "thankful", "optimistic",
])

const NEGATIVE_WORDS = new Set([
  "bad", "terrible", "horrible", "ugly", "awful", "dreadful", "hate",
  "anger", "angry", "sad", "sadness", "pain", "painful", "fear",
  "fearful", "dark", "gloomy", "miserable", "wretched", "despair",
  "grief", "sorrow", "tragic", "tragic", "bitter", "resentful",
  "frustrated", "disappointed", "pessimistic", "doom",
])

const FORMAL_WORDS = new Set([
  "therefore", "consequently", "furthermore", "moreover", "nevertheless",
  "nonetheless", "whereby", "henceforth", "subsequently", "accordingly",
  "thus", "hence", "notwithstanding", "inasmuch", "whereas", "albeit",
  "hitherto", "therein", "thereof", "pursuant",
])

const METAPHOR_MARKERS = new Set([
  "like", "as if", "as though", "resembles", "reminds me of", "echoes",
  "mirrors", "reflects", "shadow", "light", "dance", "weave", "tapestry",
  "ocean", "river", "flame", "seed", "root", "blossom", "bridge",
])

/**
 * Tokenize text into lowercase words.
 */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/\b[a-z']+\b/g) ?? []
}

/**
 * Count occurrences of words from a set in the given tokens.
 */
function countSetMatches(tokens: string[], wordSet: Set<string>): number {
  let count = 0
  for (const tok of tokens) {
    if (wordSet.has(tok)) count++
  }
  return count
}

/**
 * Extract behavioral feature values for each DAMP dimension from response text.
 * Returns a map from dimension prefix to a numeric feature value.
 *
 * These are simple heuristic proxies — they produce measurably different
 * distributions for different personality profiles, enabling statistical testing.
 */
export function extractBehavioralFeatures(text: string): Record<DAMPDimensionPrefix, number> {
  const tokens = tokenize(text)
  const wordCount = tokens.length || 1
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0)
  const sentenceCount = sentences.length || 1
  const questionMarks = (text.match(/\?/g) ?? []).length
  const uniqueWords = new Set(tokens)

  // sw (Social Warmth): warm/friendly word density
  const warmCount = countSetMatches(tokens, WARM_WORDS)
  const sw = warmCount / wordCount

  // cs (Conversational Style): composite of formality, verbosity, questions, metaphors
  const formalCount = countSetMatches(tokens, FORMAL_WORDS)
  const formality = formalCount / wordCount
  const verbosity = Math.min(wordCount / 500, 1) // normalize to 0-1 range (500 words = 1.0)
  const questionRatio = questionMarks / sentenceCount
  const metaphorCount = countSetMatches(tokens, METAPHOR_MARKERS)
  const metaphorDensity = metaphorCount / wordCount
  const cs = (formality + verbosity + questionRatio + metaphorDensity) / 4

  // as (Assertiveness): exclamation marks + imperative-like patterns + lack of hedging
  const exclamations = (text.match(/!/g) ?? []).length
  const hedgeCount = countSetMatches(tokens, HEDGING_WORDS)
  const exclamationRate = exclamations / sentenceCount
  const hedgeRate = hedgeCount / wordCount
  const as_ = Math.max(0, Math.min(1, exclamationRate * 2 + (1 - hedgeRate * 10) * 0.5))

  // cg (Cognitive Style): sentence complexity + unique word ratio
  const avgSentenceLen = wordCount / sentenceCount
  const uniqueRatio = uniqueWords.size / wordCount
  const cg = (Math.min(avgSentenceLen / 30, 1) + uniqueRatio) / 2

  // ep (Epistemic Behavior): hedging/uncertainty word density
  const ep = hedgeCount / wordCount * 5 // scale up for sensitivity

  // cr (Creativity): unique words ratio + metaphor density
  const cr = (uniqueRatio + metaphorDensity * 10) / 2

  // cv (Convergence): short sentences + concrete/practical word patterns
  const shortSentenceRatio = sentences.filter(s => s.split(/\s+/).length < 10).length / sentenceCount
  const cv = (shortSentenceRatio + formality) / 2

  // mo (Motivation): question marks (curiosity) + exclamation marks (energy)
  const mo = Math.min(1, (questionRatio + exclamationRate) / 2)

  // et (Emotional Tone): positive vs negative word balance
  const posCount = countSetMatches(tokens, POSITIVE_WORDS)
  const negCount = countSetMatches(tokens, NEGATIVE_WORDS)
  const emotionTotal = posCount + negCount
  const et = emotionTotal > 0 ? posCount / emotionTotal : 0.5

  // sc (Social Cognition): pronouns "we"/"they"/"us"/"them" density
  const socialPronouns = tokens.filter(t =>
    ["we", "us", "they", "them", "our", "their", "everyone", "people", "community"].includes(t),
  ).length
  const sc = socialPronouns / wordCount * 10 // scale up

  // ag (Agency): "I" statements + action verbs density
  const iCount = tokens.filter(t => t === "i").length
  const actionVerbs = tokens.filter(t =>
    ["do", "make", "create", "build", "start", "act", "decide", "choose", "lead", "drive"].includes(t),
  ).length
  const ag = (iCount + actionVerbs) / wordCount * 5 // scale up

  // id (Identity): consistency markers — self-referential patterns
  const selfRef = tokens.filter(t => ["my", "myself", "me", "i"].includes(t)).length
  const id = selfRef / wordCount * 5

  return {
    sw: Math.min(1, sw * 10),
    cs: Math.min(1, cs),
    as: Math.min(1, as_),
    cg: Math.min(1, cg),
    ep: Math.min(1, ep),
    cr: Math.min(1, cr),
    cv: Math.min(1, cv),
    mo: Math.min(1, mo),
    et: Math.min(1, et),
    sc: Math.min(1, sc),
    ag: Math.min(1, ag),
    id: Math.min(1, id),
  }
}

// ---------------------------------------------------------------------------
// Main Scorer
// ---------------------------------------------------------------------------

/**
 * Run dAMP behavioral distinctiveness evaluation.
 * Compares response distributions between personality pairs and checks
 * for statistical significance on behavioral dimensions.
 *
 * @param responses - Eval responses (must have personality_id and response_text)
 * @param config - DAMPEvalConfig with fingerprints and min samples
 * @returns DAMPEvalResult with per-pair dimensional analysis
 */
export function scoreDAMPDistinctiveness(
  responses: Array<{ personality_id: string; response_text: string }>,
  config: DAMPEvalConfig,
): DAMPEvalResult {
  const minSamples = config.minSamplesPerPersonality ?? 10

  // Group responses by personality and extract features
  const featuresByPersonality = new Map<string, Array<Record<DAMPDimensionPrefix, number>>>()

  for (const r of responses) {
    if (!config.fingerprints.has(r.personality_id)) continue
    const features = extractBehavioralFeatures(r.response_text)
    const existing = featuresByPersonality.get(r.personality_id) ?? []
    existing.push(features)
    featuresByPersonality.set(r.personality_id, existing)
  }

  // Filter personalities with enough samples
  const validPersonalities: string[] = []
  for (const [pid, features] of featuresByPersonality) {
    if (features.length >= minSamples) {
      validPersonalities.push(pid)
    }
  }
  validPersonalities.sort()

  // Compare all pairs
  const perPair: DAMPEvalResult["per_pair"] = []
  let maxSignificantDimensions = 0

  for (let i = 0; i < validPersonalities.length; i++) {
    for (let j = i + 1; j < validPersonalities.length; j++) {
      const pidA = validPersonalities[i]
      const pidB = validPersonalities[j]
      const featuresA = featuresByPersonality.get(pidA)!
      const featuresB = featuresByPersonality.get(pidB)!

      const dimensions: DAMPDimensionResult[] = []
      let significantCount = 0

      for (const dim of DAMP_DIMENSION_PREFIXES) {
        const valuesA = featuresA.map(f => f[dim])
        const valuesB = featuresB.map(f => f[dim])

        const meanA = mean(valuesA)
        const meanB = mean(valuesB)
        const { p } = welchTTest(valuesA, valuesB)
        const significant = p < 0.05

        if (significant) significantCount++

        dimensions.push({
          dimension: dim,
          mean_a: meanA,
          mean_b: meanB,
          p_value: p,
          significant,
        })
      }

      if (significantCount > maxSignificantDimensions) {
        maxSignificantDimensions = significantCount
      }

      perPair.push({
        personality_a: pidA,
        personality_b: pidB,
        dimensions,
        significant_count: significantCount,
      })
    }
  }

  return {
    total_pairs: perPair.length,
    dimensions_with_significant_difference: maxSignificantDimensions,
    per_pair: perPair,
    target_met: maxSignificantDimensions >= 5,
  }
}
