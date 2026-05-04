// src/substrate/event-writer-layer.ts — EventWriter Effect Layer for substrate-constructs.
//
// Cycle-032 Sprint-4. See PRD FR-4 + SDD §4.6 + build doc §5.5.
//
// Wraps `src/events/writer.ts` EventWriter interface (cycle-021 abstraction).
// Phase-3 KafkaWriter swaps in via the same Tag, different impl — but cycle-032
// ships ONLY the EventStore-backed impl per PRD §4 BARTH cut.

import { randomUUID } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import type { EventWriter as EventStoreWriter } from "../events/writer.js"
import { registerEventStream, type EventStream } from "../events/types.js"

// ── Cross-pack Tag identity contract ────────────────────────────────

/**
 * `EventWriter` Tag — string identifier "EventWriter" — must match any
 * substrate-construct that declares this requirement.
 */
export class EventWriter extends Context.Tag("EventWriter")<
  EventWriter,
  {
    readonly publish: (subject: string, payload: unknown) => Effect.Effect<void, EventWriterError>
  }
>() {}

export class EventWriterError {
  readonly _tag = "EventWriterError"
  constructor(
    readonly reason: "invalid-subject" | "append-failed" | "unknown",
    readonly message: string,
  ) {}
}

export class SubjectError {
  readonly _tag = "SubjectError"
  constructor(
    readonly subject: string,
    readonly message: string,
  ) {}
}

// ── Subject validation ──────────────────────────────────────────────

/**
 * Three-segment dotted subject regex: `{aggregate}.{noun}.{verb}`.
 * Each segment must start with a lowercase letter and contain only
 * lowercase letters, digits, and hyphens.
 *
 * Example valid: `agent.lore-essay.verdict`, `pool.payment.captured`
 * Example invalid: `Agent.X.Y` (uppercase), `agent.x` (only 2 segments),
 *                  `agent..verdict` (empty segment), `1agent.x.y` (leading digit)
 */
const SUBJECT_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){2}$/

export function validateSubject(subject: string): { ok: true; subject: string } | { ok: false; error: SubjectError } {
  if (!subject || typeof subject !== "string") {
    return { ok: false, error: new SubjectError(String(subject), "subject must be a non-empty string") }
  }
  if (!SUBJECT_PATTERN.test(subject)) {
    return {
      ok: false,
      error: new SubjectError(
        subject,
        "subject must match three-segment dotted pattern {aggregate}.{noun}.{verb} with lowercase letters/digits/hyphens",
      ),
    }
  }
  return { ok: true, subject }
}

// ── Layer factory ───────────────────────────────────────────────────

export interface BuildEventWriterLayerOptions {
  /** Injected EventStore-backed writer. Production: cycle-021 JsonlEventWriter / PostgresEventWriter. Tests: mock. */
  writer: EventStoreWriter
  /**
   * EventStream name for substrate-construct event publishing. Defaults to
   * `substrate_invocations`. Per-construct override possible (e.g.,
   * `substrate_lore_essay`) but operators usually leave default.
   */
  streamName?: string
  /**
   * Correlation ID generator. Default: crypto.randomUUID per publish. Production
   * passes a closure capturing the invocation's trace_id so all substrate-emitted
   * events trace back to the originating SubstrateStepSubmission.
   */
  correlationIdGen?: () => string
}

/**
 * Default stream all substrate-construct invocations publish to. The
 * three-segment dotted subject (e.g., `agent.lore-essay.verdict`) becomes the
 * `event_type` discriminator within this stream — preserving the cycle-021
 * EventEnvelope separation where `stream` is the routing target and
 * `event_type` is the application-level discriminator.
 *
 * `registerEventStream()` requires single-segment underscore_lowercase names
 * (`/^[a-z][a-z0-9_]*$/`) — substrate's dotted subject scheme cannot be
 * directly registered as an EventStream. Per build doc §5.5 + sprint plan
 * §4.1, we ship a constant stream + put the subject in `event_type`.
 *
 * Phase-3 KafkaWriter (deferred per BARTH cut) will use the dotted subject
 * as the Kafka topic directly. The subject lives in `event_type` of every
 * cycle-032 envelope, so Phase-3 can reconstruct the topic by reading
 * envelope.event_type without losing information.
 */
const DEFAULT_STREAM_NAME = "substrate_invocations"

/**
 * Build the Layer. Stream is registered lazily on first publish.
 * `registerEventStream()` is idempotent: re-registering returns the same brand.
 */
export const buildEventWriterLayer = (opts: BuildEventWriterLayerOptions): Layer.Layer<EventWriter> => {
  const corrIdGen = opts.correlationIdGen ?? (() => randomUUID())
  const streamName = opts.streamName ?? DEFAULT_STREAM_NAME
  let cachedStream: EventStream | null = null

  function getStream(): EventStream {
    if (!cachedStream) cachedStream = registerEventStream(streamName)
    return cachedStream
  }

  return Layer.succeed(EventWriter, {
    publish: (subject, payload) =>
      Effect.gen(function* () {
        const validation = validateSubject(subject)
        if (!validation.ok) {
          return yield* Effect.fail(
            new EventWriterError("invalid-subject", validation.error.message),
          )
        }

        const stream = getStream()
        const correlationId = corrIdGen()
        const eventType = validation.subject // dotted subject → event_type

        return yield* Effect.tryPromise({
          try: async () => {
            await opts.writer.append(stream, eventType, payload, correlationId)
          },
          catch: (cause) => new EventWriterError("append-failed", cause instanceof Error ? cause.message : String(cause)),
        })
      }),
  })
}
