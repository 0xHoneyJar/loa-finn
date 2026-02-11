---
title: "INFERRED Unknown Qualifier — Parsed but Counted as Unqualified"
---

# Test: Unknown INFERRED Qualifier

<!-- provenance: INFERRED (banana) -->
The system appears to use an event-driven architecture for inter-module communication, though the specific implementation pattern has not been verified against the source code. This uses an unknown qualifier that should be accepted by the permissive parser but counted as unqualified by consumers.

<!-- provenance: CODE-FACTUAL -->
The WAL rotation threshold is configured at 10MB (`src/persistence/wal.ts:42`).
