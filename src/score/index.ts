// src/score/index.ts — public surface of the Score Phase-1 forensic core (cycle-041 Sprint 1)
//
// Phase 1 is a read-only, no-LLM, deterministic leaderboard X-ray. This barrel exposes the
// FR-6 port + adapters and the pure analysis core only — no ingestion, persistence, report,
// or publication (Sprints 2–4).

export * from "./edge/port.js"
export * from "./edge/adapters.js"
export * from "./core/leaderboard.js"
export * from "./core/features.js"
export * from "./core/cluster.js"
export * from "./core/screen.js"
