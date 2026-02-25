# NOTES.md

## Learnings

### TypeBox FormatRegistry Footgun (cycle-033, T-3.9)

**Symptom**: `Value.Check()` silently passes invalid UUIDs and date-time strings.

**Cause**: TypeBox's `FormatRegistry` starts empty. Schemas using `{ format: "uuid" }` or
`{ format: "date-time" }` constraints will pass _any_ string if the format checker is not
registered first. The `import "./typebox-formats.js"` side-effect import registers these
formats, but side-effect imports are fragile — test runners may hoist or reorder imports,
and tree-shakers may eliminate "unused" imports.

**Fix (defense-in-depth)**:
1. **Side-effect import**: `import "./typebox-formats.js"` at module top (primary).
2. **Runtime guard**: Check `FormatRegistry.Has("uuid")` before `Value.Check()` and throw
   an explicit error if not registered (belt-and-suspenders, T-3.2).
3. **Test setup**: `tests/setup/typebox-formats.setup.ts` registered as vitest `setupFiles`
   ensures formats are available regardless of test order (T-3.3).

**Reference**: Bridgebuilder review Finding F4 (Medium), PR #107.

### Routing Vocabulary: 6 TaskTypes → 5 RoutingKeys (cycle-033, T-3.9)

**Decision**: Protocol defines 6 `TaskType` values: `code_review`, `creative_writing`,
`analysis`, `summarization`, `general`, `unspecified`. These map to 5 `NFTRoutingKey` values:
`code`, `chat`, `analysis`, `default` (×2), with `summarization` mapping to `analysis`.

**Rationale**: `summarization` and `analysis` are both "deep-think" tasks requiring
reasoning-capable models. Merging them at the routing layer keeps pool configuration simple
(5 slots per personality, not 6) while the protocol retains semantic precision for telemetry.
This parallels Kubernetes CRD extensibility — multiple API resources can map to a single
controller when the execution characteristics are equivalent.

**Compile-time safety**: `mapKnownTaskType()` has no `default` branch — if a new protocol
variant is added to the `TaskType` union, TypeScript will produce a compile error until the
mapping is updated (T-3.1).

**Reference**: Bridgebuilder review Finding F5 (Medium) + F10 (Medium), PR #107.

## Blockers
