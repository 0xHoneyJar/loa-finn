---
title: Regression Test — Stacked CODE-FACTUAL Paragraphs
version: 1.0.0
---

# Regression: Stacked CODE-FACTUAL

> This fixture reproduces the 14-failure regression from cycle-010 Sprint 2:
> Two CODE-FACTUAL paragraphs within 10 lines of each other, each with
> different evidence anchors pointing to different citations. The old ±10 line
> proximity heuristic would confuse the second anchor with the first citation.

## Persistence & Orchestration

<!-- provenance: CODE-FACTUAL -->
<!-- evidence: symbol=WALManager, symbol=createWALManager -->
The persistence layer at `src/persistence/index.ts:1-6` composes durability via `WALManager` and `createWALManager`.

<!-- provenance: CODE-FACTUAL -->
<!-- evidence: symbol=CronService, symbol=CircuitBreaker -->
The scheduling system at `src/cron/service.ts:1-8` provides `CronService` with per-job `CircuitBreaker` isolation.

## Safety & Gateway

<!-- provenance: CODE-FACTUAL -->
<!-- evidence: symbol=PoolErrorCode, symbol=PoolError -->
The worker pool at `src/agent/worker-pool.ts:17-30` implements `PoolErrorCode` and `PoolError` for typed error handling.

<!-- provenance: CODE-FACTUAL -->
<!-- evidence: symbol=createApp, symbol=AppOptions -->
The gateway at `src/gateway/server.ts:19-30` uses `createApp` with `AppOptions` for dependency injection.

## Summary

<!-- provenance: ANALOGY -->
Like PostgreSQL's WAL, each component operates independently through well-defined interfaces.
