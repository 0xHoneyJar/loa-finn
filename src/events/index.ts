/**
 * EventStore Module — Sprint 1 (GID 121)
 *
 * Unified event infrastructure for loa-finn's 4 append-only streams.
 * Backend-agnostic: JSONL files and Postgres both implement the same interfaces.
 */

// Types and stream registry
export {
  type EventEnvelope,
  type EventCursor,
  type EventStream,
  EVENT_ENVELOPE_SCHEMA_VERSION,
  registerEventStream,
  isRegisteredStream,
  assertRegisteredStream,
  getRegisteredStreams,
  STREAM_BILLING,
  STREAM_CREDIT,
  STREAM_RECONCILIATION,
  STREAM_PERSONALITY,
  STREAM_ROUTING_QUALITY,
  fromBillingEnvelope,
  toBillingEnvelope,
  computePayloadChecksum,
  crc32,
} from "./types.js"

// Interfaces
export { type EventWriter } from "./writer.js"
export { type EventReader } from "./reader.js"

// JSONL backend
export { JsonlEventWriter, type JsonlEventWriterOptions } from "./jsonl-writer.js"
export { JsonlEventReader, type JsonlEventReaderOptions } from "./jsonl-reader.js"

// Postgres backend
export { PostgresEventWriter, type PostgresEventWriterOptions } from "./pg-writer.js"
export { PostgresEventReader, type PostgresEventReaderOptions } from "./pg-reader.js"
