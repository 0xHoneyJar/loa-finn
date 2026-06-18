// src/research/spine-ledger.ts — the durable, append-only spine ledger
// (bd-8ywq.7 · Acceptance Contract C).
//
// The lab's Ledger of Bets. Contract C migrates the spine from a flat JSON file
// (observatory/spine-data.json — which CANNOT be safely appended by concurrent
// writers, and a mid-write crash corrupts the whole audit trail) to a JSONL
// append: one event = one line, the chain walks in order, the file is never
// deserialized-then-rewritten on write.
//
// HARD BOUNDARY: this module NEVER touches observatory/spine-data.json. The
// viewer integration (re-pointing the observatory at this JSONL) is a noted
// follow-up — out of scope for .7. This writer only appends to its own ledger.
//
// Durability mechanism (the three Contract-C requirements):
//   · single-writer  — every append is serialized through an advisory lock so
//                       two probes can never interleave a partial line.
//   · advisory flock — a lockfile (O_CREAT|O_EXCL, the portable POSIX advisory
//                       lock; with a stale-lock steal so a crashed writer can't
//                       deadlock the ledger). The lock is the ONLY serializer —
//                       there is deliberately no in-process promise chain, so a
//                       Promise.all of appends on one instance genuinely
//                       exercises the lock (the concurrent-probe stress test).
//   · fsync          — the data fd is fsync'd before the lock releases, so an
//                       acknowledged append is durable across a crash.
//
// Each event is hash-chained: `prev_hash` links to the sha256 of the previous
// event's canonical JSON (or GENESIS_HASH for the first). Tampering with any
// stored field, or deleting/reordering a line, breaks the replay — so a
// corrupted or lost event is DETECTABLE, not silent.

import { createHash } from "node:crypto"
import { open, mkdir, readFile, stat, unlink } from "node:fs/promises"
import { dirname } from "node:path"
import { canonicalJson } from "./cost-atom-research.js"
import { GENESIS_HASH } from "./schemas/index.js"
import type { ResearchSpineEvent } from "./schemas/index.js"

/** Default ledger path (configurable via the writer constructor). */
export const SPINE_EVENTS_PATH = "src/research/spine-events.jsonl"

/** A spine event before the ledger assigns its chain link. The writer owns
 *  `prev_hash` — a caller cannot forge the chain position. */
export type SpineEventInput = Omit<ResearchSpineEvent, "prev_hash">

/** Link hash of a spine event = sha256 of its canonical JSON (the event INCLUDES
 *  its own `prev_hash`, so the hash binds the whole chain position). The next
 *  event's `prev_hash` is this value. */
export function spineEventHash(event: ResearchSpineEvent): string {
  return createHash("sha256").update(canonicalJson(event)).digest("hex")
}

// ---------------------------------------------------------------------------
// Advisory lock — a lockfile is the portable POSIX advisory lock. fs.open with
// the 'wx' flag is O_CREAT|O_EXCL: the kernel guarantees exactly one opener
// wins, even across processes. A stale lock (older than staleMs — a crashed
// writer) is stolen so the ledger never deadlocks.
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface LockOptions {
  /** Give up acquiring after this long (ms). */
  timeout_ms?: number
  /** Treat a lockfile older than this (ms) as a crashed writer's — steal it. */
  stale_ms?: number
}

async function withFileLock<T>(
  lockPath: string,
  opts: LockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const timeoutMs = opts.timeout_ms ?? 10_000
  const staleMs = opts.stale_ms ?? 30_000
  const deadline = Date.now() + timeoutMs
  // Acquire.
  for (;;) {
    try {
      const fh = await open(lockPath, "wx")
      await fh.close()
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      // Stale-lock steal — a crashed writer must not deadlock the ledger.
      try {
        const st = await stat(lockPath)
        if (Date.now() - st.mtimeMs > staleMs) {
          await unlink(lockPath).catch(() => {})
          continue
        }
      } catch {
        // lock vanished between EEXIST and stat — retry immediately
        continue
      }
      if (Date.now() > deadline) {
        throw new Error(`spine-ledger: lock acquisition timed out after ${timeoutMs}ms (${lockPath})`)
      }
      // Jittered backoff to avoid a thundering retry storm under contention.
      await sleep(2 + Math.random() * 6)
    }
  }
  // Critical section + guaranteed release.
  try {
    return await fn()
  } finally {
    await unlink(lockPath).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// The append-only, flock'd, fsync'd spine writer.
// ---------------------------------------------------------------------------

export class SpineEventWriter {
  readonly lockPath: string
  constructor(
    readonly path: string = SPINE_EVENTS_PATH,
    private readonly lockOpts: LockOptions = {},
  ) {
    this.lockPath = `${path}.lock`
  }

  /** Recover the current chain head (sha256 of the last event) by reading the
   *  ledger's last non-empty line. Called UNDER the lock every append, so a
   *  concurrent writer's event is always seen (no cached/stale head — the source
   *  of lost-update bugs in multi-writer ledgers). A torn final line (a crash
   *  mid-write) is quarantined: we walk back to the last parseable event. */
  private async recoverHead(): Promise<string> {
    let raw: string
    try {
      raw = await readFile(this.path, "utf-8")
    } catch {
      return GENESIS_HASH
    }
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]) as ResearchSpineEvent
        return spineEventHash(ev)
      } catch {
        // corrupt-tail quarantine: skip the torn line, try the prior one
      }
    }
    return GENESIS_HASH
  }

  /** Append one spine event. Under the advisory lock: re-derive the chain head,
   *  stamp `prev_hash`, write the line, fsync, release. Resolves with the stored
   *  event (its assigned `prev_hash`). */
  async append(event: SpineEventInput): Promise<ResearchSpineEvent> {
    await mkdir(dirname(this.path), { recursive: true })
    return withFileLock(this.lockPath, this.lockOpts, async () => {
      const prevHash = await this.recoverHead()
      const stored: ResearchSpineEvent = { ...event, prev_hash: prevHash }
      const line = JSON.stringify(stored) + "\n"
      const fh = await open(this.path, "a")
      try {
        await fh.write(line)
        await fh.sync() // fsync — an acknowledged append survives a crash
      } finally {
        await fh.close()
      }
      return stored
    })
  }
}

// ---------------------------------------------------------------------------
// Reader + replay verification (the "replay reproduces" half of Contract C).
// ---------------------------------------------------------------------------

export interface SpineReadResult {
  events: ResearchSpineEvent[]
  /** A torn final line was skipped (crash mid-write) — informational, not fatal. */
  corrupt_tail: boolean
}

/** Read the spine ledger into events. A torn FINAL line is quarantined (skipped)
 *  rather than throwing — a crash mid-append must not make the whole audit trail
 *  unreadable. A corrupt line that is NOT the tail throws (real corruption). */
export async function readSpineEvents(path: string): Promise<SpineReadResult> {
  const raw = await readFile(path, "utf-8")
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean)
  const events: ResearchSpineEvent[] = []
  let corruptTail = false
  for (let i = 0; i < lines.length; i++) {
    try {
      events.push(JSON.parse(lines[i]) as ResearchSpineEvent)
    } catch (err) {
      if (i === lines.length - 1) {
        corruptTail = true // tolerate a torn tail
        break
      }
      throw new Error(`spine-ledger: corrupt event at line ${i} (not the tail): ${String(err)}`)
    }
  }
  return { events, corrupt_tail: corruptTail }
}

export interface SpineChainVerification {
  valid: boolean
  length: number
  /** Index of the first broken link, or null if the chain replays cleanly. */
  brokenAt: number | null
  reason: string | null
}

/** Replay the chain from genesis: every event's `prev_hash` must equal the
 *  sha256 of the prior event (GENESIS for the first). A lost, duplicated,
 *  reordered, or tampered event breaks the replay. */
export function verifySpineChain(events: ResearchSpineEvent[]): SpineChainVerification {
  let prev = GENESIS_HASH
  for (let i = 0; i < events.length; i++) {
    if (events[i].prev_hash !== prev) {
      return { valid: false, length: events.length, brokenAt: i, reason: `prev_hash break at index ${i}` }
    }
    prev = spineEventHash(events[i])
  }
  return { valid: true, length: events.length, brokenAt: null, reason: null }
}
