# Sprint Plan: First-Class Construct Support

**Cycle**: cycle-051
**PRD**: grimoires/loa/prd.md
**SDD**: grimoires/loa/sdd.md
**Created**: 2026-03-23
**Sprints**: 4 (global IDs: 103-106)
**Total FRs**: 6

## Sprint Overview

First-class construct support for the Loa framework. Constructs become discoverable, composable, and operator-facing through index generation, name resolution, capability aggregation, and ambient greeting integration.

| Sprint | Label | FRs | Tasks | Tests |
|--------|-------|-----|-------|-------|
| 1 (103) | Index Generation + Capability Aggregation | FR-1, FR-6 | 4 | 12 |
| 2 (104) | Name Resolution + Composition | FR-2, FR-3 | 5 | 12 |
| 3 (105) | Operator OS + Ambient Greeting | FR-4, FR-5 | 5 | 16 |
| 4 (106) | Integration + E2E Validation | Cross-cutting | 5 | 3 + E2E |

---

## Sprint 103: Index Generation + Capability Aggregation

**Global ID**: 103
**FRs**: FR-1 (Construct Index Generation), FR-6 (Capability Aggregation)
**Goal**: Generate a machine-readable index of all installed constructs and aggregate their declared capabilities into a queryable registry.

### Tasks

| ID | Task | Acceptance Criteria | Goal |
|----|------|---------------------|------|
| T1.1 | Create `construct-index-gen.sh` that scans construct directories and emits JSON index | Scans `.claude/constructs/` and pack dirs. Outputs JSON with name, version, path, type per construct. Handles missing/malformed manifests gracefully. | FR-1 |
| T1.2 | Add incremental index generation with staleness detection | Compares mtimes against cached index. Only re-indexes changed constructs. `--force` flag bypasses cache. | FR-1 |
| T1.3 | Create `capability-aggregator.sh` that collects capabilities from construct manifests | Reads `capabilities` field from each construct manifest. Produces merged capability map (capability -> list of providing constructs). Deduplicates. | FR-6 |
| T1.4 | Write BATS tests for index generation and capability aggregation | 12 tests: valid constructs, missing manifests, malformed YAML, incremental rebuild, force flag, empty dir, capability merge, duplicate capabilities, capability query, no capabilities declared, mixed valid/invalid, staleness detection. All pass in isolation. | FR-1, FR-6 |

---

## Sprint 104: Name Resolution + Composition

**Global ID**: 104
**FRs**: FR-2 (Name Resolution), FR-3 (Construct Composition)
**Goal**: Resolve construct references by name (with version constraints) and enable constructs to declare dependencies on other constructs.

### Tasks

| ID | Task | Acceptance Criteria | Goal |
|----|------|---------------------|------|
| T2.1 | Create `construct-resolver.sh` with name-to-path resolution | Resolves `name` and `name@version` to filesystem path. Uses index from Sprint 103. Returns error for unresolved names. Supports glob version matching. | FR-2 |
| T2.2 | Add resolution scope rules (local > pack > remote) | Resolution priority: project-local constructs first, then installed packs, then registry. Scope documented and configurable. | FR-2 |
| T2.3 | Create `construct-compose.sh` for dependency declaration and validation | Reads `depends` field from construct manifests. Validates all dependencies resolvable. Detects circular dependencies. Produces topological sort order. | FR-3 |
| T2.4 | Add composition conflict detection | Detects capability conflicts (two constructs providing same capability with incompatible versions). Reports conflicts with actionable messages. | FR-3 |
| T2.5 | Write BATS tests for name resolution and composition | 12 tests: exact name match, versioned match, version glob, local-over-pack priority, unresolved name, dependency resolution, circular dependency detection, topological sort, capability conflict, missing dependency, nested dependencies, scope override. All pass in isolation. | FR-2, FR-3 |

---

## Sprint 105: Operator OS + Ambient Greeting

**Global ID**: 105
**FRs**: FR-4 (Operator OS Integration), FR-5 (Ambient Greeting)
**Goal**: Surface construct information in the operator experience and integrate construct awareness into the ambient greeting shown at session start.

### Tasks

| ID | Task | Acceptance Criteria | Goal |
|----|------|---------------------|------|
| T3.1 | Add construct status to `/loa` golden path output | `/loa` shows installed construct count, active constructs, any health warnings. Uses index from Sprint 103. Graceful when no constructs installed. | FR-4 |
| T3.2 | Create `construct-health.sh` for construct health checks | Validates each construct: manifest parseable, dependencies met, no conflicts, required files present. Returns per-construct health status. `--json` output. | FR-4 |
| T3.3 | Integrate construct capabilities into ambient greeting | Session greeting includes active construct names and top-level capabilities. Respects `greeting.show_constructs` config. Truncates gracefully for many constructs. | FR-5 |
| T3.4 | Add construct-aware `/help` suggestions | When user query matches a construct capability, suggest relevant construct. Uses capability registry from FR-6. Non-intrusive (suggestion only). | FR-5 |
| T3.5 | Write BATS tests for operator OS and ambient greeting | 16 tests: /loa with constructs, /loa without constructs, health check pass, health check fail (missing dep), health check fail (bad manifest), health JSON output, greeting with constructs, greeting without constructs, greeting config disabled, greeting truncation, help suggestion match, help no match, multiple construct health, health warning propagation, greeting capability display, config override. All pass in isolation. | FR-4, FR-5 |

---

## Sprint 106: Integration + E2E Validation

**Global ID**: 106
**FRs**: Cross-cutting (all FRs)
**Goal**: Validate all construct support features work together end-to-end. Ensure the full lifecycle (install -> index -> resolve -> compose -> greet) is coherent.

### Tasks

| ID | Task | Acceptance Criteria | Goal |
|----|------|---------------------|------|
| T4.1 | Create integration test: install -> index -> resolve -> compose pipeline | Test installs a mock construct pack, generates index, resolves by name, validates composition. Full pipeline passes. | All FRs |
| T4.2 | Create E2E test: construct lifecycle with operator OS | Test walks through construct installation, verifies `/loa` output, checks greeting, validates health. Uses real scripts (not mocks). | FR-4, FR-5 |
| T4.3 | Add CI validation for construct index freshness | CI step regenerates index and diffs against committed index. Fails if stale. Prevents drift between installed constructs and index. | FR-1 |
| T4.4 | Update construct protocol documentation | `.claude/protocols/construct-support.md` documents index format, resolution rules, composition semantics, capability schema. References SDD sections. | All FRs |
| T4.5 | Add construct troubleshooting to `/loa doctor` | `/loa doctor` includes construct health checks. Reports: missing dependencies, stale index, capability conflicts, malformed manifests. Actionable fix suggestions. | FR-4 |

---
