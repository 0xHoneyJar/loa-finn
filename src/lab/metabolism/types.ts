// src/lab/metabolism/types.ts — the integer-domain receipt types for the
// bd-ryza PSRO toy loop (SEGMENT A — Foundation).
//
// The loop is Hand-agnostic: it never inspects strategy internals — it asks the
// Hand to evaluate pairs and asks the Oracle (segment B) to propose new vectors.
// A Strategy is therefore an OPAQUE parameter vector. Each Hand interprets it:
// ToyHand uses vec[0] (a scalar), CabtHand maps vec[0..7] to the heuristic
// `_BASE` priors (src/cabt/heuristic.py:20).
//
// INTEGER-DOMAIN DISCIPLINE (locked decision #5, bd-ryza spec):
//   · Internal solver math may be float; everything WRITTEN to a ledger receipt
//     is integer. Win-rate = `winrate_ppm ∈ [0, 1_000_000]`.
//   · Strategy vectors are stored as integer MILLI (`vec_milli`), NEVER float.
//   · `assertIntegerDomain` is the write-time gate — a float reaching a `.jsonl`
//     line is a BLOCKER. It is a MECHANISM, not a sentence (mirrors
//     `assertAtomIntegerMicro`, cost-atom-research.ts:87-103, and
//     `assertDecisionValid`, decision-forecast.ts:256).

/** Which Hand produced a receipt. `toy` = the deterministic CI Hand; `cabt` =
 *  the cg-engine adapter (shelled, linux/amd64). */
export type HandKind = "toy" | "cabt"

/** An OPAQUE parameter vector + its content-addressed id. The loop never reads
 *  `vec` — only the Hand does. `vec` is a float[] in [0,1] at the in-memory
 *  boundary (the Oracle proposes floats); it is converted to integer milli
 *  (`toMilli`) before it ever touches a ledger. */
export interface Strategy {
  /** sha256 hex of the canonical integer-milli vector — content-addressed, so
   *  two strategies with the same vector share one id (the Archivist dedups). */
  id: string
  /** The live parameter vector, float in [0,1]. NEVER serialized as-is. */
  vec: number[]
}

/** A match receipt — the Custodian's custody stamp for one (a vs b) evaluation.
 *  Every numeric field is integer-domain: win-rate is ppm, counts are integers,
 *  timestamps are epoch-ms integers. NO FLOATS. */
export interface MatchReceipt {
  /** A-vs-B win-rate, integer parts-per-million in [0, 1_000_000]. */
  winrate_ppm: number
  /** Number of matches the win-rate is measured over. */
  n_matches: number
  /** Which Hand measured this. */
  hand_kind: HandKind
  /** Content-addressed id of strategy A. */
  strategy_a: string
  /** Content-addressed id of strategy B. */
  strategy_b: string
  /** Unix epoch ms. */
  ts: number
}

/** A population record — the Archivist's append-only entry for one strategy that
 *  entered the population. The vector is stored as integer MILLI (round(x*1000))
 *  to honor no-floats; rehydrate with `fromMilli`. */
export interface PopulationRecord {
  /** Content-addressed id (sha256 hex of the canonical vec_milli). */
  strategy_id: string
  /** The parameter vector as integer milli (round(x*1000)). NEVER float. */
  vec_milli: number[]
  /** Which Hand this strategy is meant for (determines vec interpretation). */
  hand_kind: HandKind
  /** PSRO iteration at which this strategy entered the population. */
  iteration: number
  /** Unix epoch ms. */
  ts: number
}

/** The ppm scale — a win-rate of 1.0 is 1_000_000 ppm. */
export const PPM_SCALE = 1_000_000 as const

/** The milli scale — a vector component of 1.0 is 1000 milli. */
export const MILLI_SCALE = 1000 as const

/** Map a float probability/rate in [0,1] to integer ppm in [0, 1_000_000].
 *  The single rounding seam: float math happens before this, integers after. */
export function toPpm(rate: number): number {
  if (typeof rate !== "number" || !Number.isFinite(rate)) {
    throw new Error(`toPpm: rate must be a finite number, got ${rate}`)
  }
  const ppm = Math.round(rate * PPM_SCALE)
  // Clamp defensively — a kernel value just outside [0,1] from float error must
  // not produce an out-of-domain ppm that fails assertIntegerDomain downstream.
  return Math.min(PPM_SCALE, Math.max(0, ppm))
}

/** Map a float vector in [0,1] to integer milli — the boundary where a live
 *  Strategy.vec becomes a serializable PopulationRecord.vec_milli. */
export function toMilli(vec: number[]): number[] {
  return vec.map((x) => {
    if (typeof x !== "number" || !Number.isFinite(x)) {
      throw new Error(`toMilli: vector component must be a finite number, got ${x}`)
    }
    return Math.round(x * MILLI_SCALE)
  })
}

/** Rehydrate an integer-milli vector back to floats in [0,1] — the inverse of
 *  `toMilli`, used when a stored strategy is replayed through a Hand. */
export function fromMilli(vecMilli: number[]): number[] {
  return vecMilli.map((m) => m / MILLI_SCALE)
}

/** Throws if ANY numeric field of a record is not an integer (the no-float
 *  gate, applied at WRITE time so float contamination fails here, not at read
 *  time — mirrors assertAtomIntegerMicro). Walks the record recursively so a
 *  float buried in a nested array (e.g. a vec component) is still caught.
 *  Non-numeric fields (strings, booleans) pass through untouched. */
export function assertIntegerDomain(record: unknown, path = "record"): void {
  if (typeof record === "number") {
    if (!Number.isInteger(record)) {
      throw new Error(`integer-domain: ${path} must be an integer, got ${record}`)
    }
    return
  }
  if (Array.isArray(record)) {
    record.forEach((v, i) => assertIntegerDomain(v, `${path}[${i}]`))
    return
  }
  if (record !== null && typeof record === "object") {
    for (const [key, v] of Object.entries(record as Record<string, unknown>)) {
      assertIntegerDomain(v, `${path}.${key}`)
    }
  }
}
