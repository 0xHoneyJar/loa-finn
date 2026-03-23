# PRD: First-Class Construct Support in Loa

**Cycle**: cycle-051
**Created**: 2026-03-23
**Sources**: RFC #452 (First-Class Construct Support), companion RFC loa-constructs#181 (schema hygiene)
**Dependencies**: Cycle-050 capabilities taxonomy (v1.65.0, PR #451)

## 1. Problem Statement

Constructs in Loa are installed, loaded, and validated — but they remain inert assets that the agent cannot discover, compose, or activate without manual invocation. A user who installs the `k-hole` construct and says "dig into this codebase" gets no response because the agent has no index mapping construct names to capabilities, no mechanism to pipe one construct's output into another's input, and no way to activate a personal workflow mode. The infrastructure exists (`constructs-loader.sh`, `constructs-lib.sh`, `constructs-install.sh`) but stops at the loading boundary. First-class construct support means the agent can see what's installed, resolve names to personas, compose constructs via declared read/write paths, and let users define personal operating modes — all without prescribing how anyone should work.

> Sources: RFC #452, interview notes (zkSoju conductor-style, janitooor dagger-style usage patterns)

## 2. Goals & Success Criteria

| Goal | Metric | Layer |
|------|--------|-------|
| Agent knows what constructs are installed | `.run/construct-index.yaml` generated on session start with all installed packs indexed | L1 |
| Construct names resolve to personas and skills | Saying "observer" loads observer persona and scopes its skills within 50ms of index lookup | L2 |
| Constructs can be piped via declared paths | `writes`/`reads` overlap detected; X then Y execution confirmed when material chain exists | L3 |
| Users can define personal workflow modes | `.loa.config.yaml` `operator_os.modes` activates archetype with merged gates and entry point | L4 |
| Session greeting surfaces installed context | Opt-in greeting shows active constructs, compositions, entry points, and open threads | L5 |
| Capabilities aggregated per construct | Construct index includes union of all skill capabilities from cycle-050 taxonomy | L1+L2 |

### DX Feel Criteria (qualitative)

- A new user who installs a construct and says its name should feel like the agent "already knows" it
- Piping two constructs should feel as natural as Unix pipes — obvious when it works, honest when it doesn't
- Operator OS modes should feel like switching gears, not configuring a system
- The greeting should feel like a butler opening the door, not a boot screen

### Measurable Criteria

| Metric | Target |
|--------|--------|
| Index generation time | < 500ms (local manifest parse, no network) |
| Name resolution overhead | < 50ms (YAML index lookup) |
| Construct install → index update latency | Same session (regenerate on pack change) |
| Sparse schema graceful degradation | 100% of features degrade without error when fields missing |

## 3. User Context

**Primary personas**:

- **zkSoju** (conductor style): Installs multiple constructs, orchestrates them in composition. Wants to say "pipe k-hole findings into observer canvases" and have it work. Defines custom modes like `/feel`, `/dig`, `/arch` that activate construct combinations.
- **janitooor** (dagger style): Deep-dives with one construct at a time. Wants name resolution to instantly load persona and scope. Rarely uses composition but wants the greeting to show open threads from previous sessions.

**Pain points** (from RFC #452):
- "I install a construct and the agent doesn't know it exists unless I invoke a specific skill"
- "There's no way to chain construct outputs without manual file copying"
- "I can't define my own workflow modes — every session starts the same"

## 4. Functional Requirements

### FR-1: Construct Index (L1)

**Problem**: The agent has no structured view of installed constructs. `constructs-loader.sh` manages loading and validation but does not produce a queryable index.

**Solution**: Extend the construct loading pipeline (new script or extension to `constructs-loader.sh`) to generate `.run/construct-index.yaml` on session start.

**Index schema** (per construct entry):
```yaml
constructs:
  - slug: "k-hole"
    name: "K-Hole"
    version: "1.2.1"
    persona_path: "skills/k-hole/persona.md"     # null if not found
    quick_start: "/dig"                            # null if not declared
    skills:
      - slug: "deep-research"
        path: "skills/deep-research/"
    commands:
      - name: "dig"
        path: "commands/dig.md"
    writes:
      - "grimoires/{construct}/research/"
      - "grimoires/{construct}/canvases/"
    reads:
      - "grimoires/loa/prd.md"
      - "grimoires/loa/sdd.md"
    gates:
      review: true
      audit: false
    composes_with:
      - slug: "observer"
        via: "grimoires/{construct}/canvases/"
    events:
      emits: ["khole.deep_dive_complete"]
      consumes: ["product.feature_shipped"]
    aggregated_capabilities:
      schema_version: 1
      read_files: true
      search_code: true
      write_files: true
      execute_commands: true
      web_access: true
      user_interaction: false
      agent_spawn: false
      task_management: false
    tags: ["research", "analysis"]
metadata:
  generated_at: "2026-03-23T10:00:00Z"
  generator_version: "1.0.0"
  pack_count: 3
```

**Behavior**:
- Parse each installed pack's `manifest.json` (in `.claude/constructs/packs/*/`)
- If `construct.yaml` exists alongside manifest, merge its fields (construct.yaml takes precedence for overlapping fields)
- Missing fields resolve to `null` or empty list — never block index generation
- Regenerate when packs change (new install, update, removal)
- Index lives in `.run/` (State Zone, ephemeral per session)

**Acceptance criteria**:
- `.run/construct-index.yaml` generated on session start when packs are installed
- All installed packs appear in index with at minimum `slug`, `name`, `version`, `skills`, `commands`
- Missing optional fields (`persona_path`, `quick_start`, `writes`, `reads`, `gates`, `composes_with`) resolve to null/empty without error
- Index regenerates when `constructs-install.sh` completes
- Index generation completes in < 500ms for 5 packs with 10 skills each
- BATS test validates index structure for a mock pack with sparse manifest

### FR-2: Name Resolution (L2)

**Problem**: The agent cannot map a construct name or slug to its persona, skills, and scoped paths. Users must know exact skill invocation syntax.

**Solution**: Two-tier name resolution:
1. **CLAUDE.md instruction** (baseline): "When a construct name is mentioned, check `.run/construct-index.yaml` for matching slug or name. If found, load its persona and activate its skill context."
2. **Optional hook** (InstructionsLoaded event): Inject construct index summary into agent context on session start.

**Resolution order**:
1. Exact slug match (e.g., "k-hole" → `k-hole` entry)
2. Name match, case-insensitive (e.g., "K-Hole" → `k-hole` entry)
3. Command match (e.g., "dig" → construct owning `/dig` command)
4. Collision warning if multiple constructs match the same command name

**On match, the agent should**:
- Load the construct's persona file (if `persona_path` is non-null)
- Scope grimoire paths to the construct's `writes`/`reads` declarations
- Surface the construct's skills as available actions
- Note the construct's `gates` for workflow compliance

**Acceptance criteria**:
- CLAUDE.md instruction added (conditional: only when constructs are installed)
- Slug match resolves correctly for installed construct
- Case-insensitive name match resolves correctly
- Command match resolves to owning construct
- Collision between two constructs claiming the same command produces a warning (not a silent pick)
- Resolution adds < 50ms to agent response (index lookup, not LLM inference)
- BATS test validates resolution order with mock index containing collisions

### FR-3: Composition as Pipe (L3)

**Problem**: Users cannot chain construct outputs into inputs. The `gtm-collective` manifest declares events but not file-based write/read paths, so there is no material chain for piping.

**Solution**: Path-based composition via `writes`/`reads` overlap detection.

**When user says "pipe X into Y" or "X's findings should feed Y"**:
1. Look up X's `writes` paths and Y's `reads` paths in construct index
2. If path overlap exists → material chain confirmed → execute X, then pass output to Y
3. If no overlap → tell user honestly ("No declared path overlap between X and Y"), offer to connect manually
4. Log composition to `.run/audit.jsonl` for traceability

**For Agent Teams composition** (when CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1):
- Agents named by construct slug auto-load persona from index
- Team lead coordinates via construct index for task routing

**Feedback routing**:
- If construct declares a `repository` field in manifest, route issues there (not to Loa repo)

**Path conflict detection**:
- Reuse `mount-conflict-detect.sh` pattern for detecting when two constructs declare conflicting `writes` to the same path
- Warn on conflict; do not block (user may intend shared workspace)

**Acceptance criteria**:
- "pipe X into Y" resolves to writes/reads overlap check
- Overlap confirmed → X executed, output paths passed to Y
- No overlap → honest message to user with manual connection offer
- Composition logged to `.run/audit.jsonl`
- Path conflict between two constructs' `writes` produces a warning
- BATS test validates overlap detection with mock constructs having shared and disjoint paths

### FR-4: Personal Operator OS (L4)

**Problem**: Users cannot define personal workflow modes. Every session starts the same regardless of installed constructs or user preferences.

**Solution**: Mode definitions in `.loa.config.yaml` that map to construct compositions.

**Schema**:
```yaml
operator_os:
  modes:
    feel:
      constructs: [artisan, observer]
      entry_point: /feel
    dig:
      constructs: [k-hole]
      entry_point: /dig
    arch:
      constructs: [arcade]
      entry_point: /arch
```

**Archetype resolver**:
1. Read installed constructs from `.run/construct-index.yaml`
2. Read mode definitions from `.loa.config.yaml` `operator_os.modes`
3. Validate that all constructs referenced in modes are actually installed
4. When user says a mode name → activate archetype:
   - Merge gates from all constructs in the mode (most restrictive wins for `review`/`audit`)
   - Set entry point as the mode's declared entry point
   - Write `.run/archetype.yaml` with active state

**`.run/archetype.yaml` schema**:
```yaml
active_mode: "dig"
active_constructs:
  - slug: "k-hole"
    version: "1.2.1"
merged_gates:
  review: true
  audit: false
entry_point: "/dig"
activated_at: "2026-03-23T10:00:00Z"
```

**When no mode active** → Loa operates normally. Modes are never forced. No mode is the default mode.

**Acceptance criteria**:
- `.loa.config.yaml` `operator_os.modes` parsed correctly
- Mode referencing uninstalled construct → clear error with install instruction
- Mode activation writes `.run/archetype.yaml`
- Merged gates use most-restrictive-wins policy
- Entry point from mode definition is set on activation
- Deactivation clears `.run/archetype.yaml`
- BATS test validates mode activation, gate merging, and uninstalled construct error

### FR-5: Ambient Protocol Presence (L5)

**Problem**: Sessions start cold. The agent does not communicate what constructs are available, what compositions exist, or what threads are open from previous sessions.

**Solution**: Opt-in session greeting and open thread tracking.

**Session greeting** (opt-in via `.loa.config.yaml`):
```yaml
constructs:
  ambient_greeting: true
```

**Greeting format**:
```
Active: k-hole (v1.2.1), artisan (v1.0.0)
Compositions: k-hole → observer (research → canvases)
Entry: /dig | /feel | /observe
Beads: 3 open threads from previous sessions
```

**Greeting assembly**:
1. Read `.run/construct-index.yaml` for active constructs and versions
2. Detect compositions from `writes`/`reads` overlap (same logic as FR-3)
3. Read entry points from construct index and active modes
4. Count open beads threads (from beads state)
5. Check `.run/open-threads.jsonl` for stale discussion threads

**Open thread tracking**:
- `.run/open-threads.jsonl` — lightweight log of discussed-but-not-completed items
- Each entry: `{"id": "uuid", "topic": "...", "construct": "k-hole", "created_at": "...", "status": "open"}`
- On session start: surface stale threads ("3 open threads from previous sessions. Want to review?")
- Threads auto-close when the associated beads task closes
- Threads older than 30 days auto-archive (configurable via `.loa.config.yaml`)

**QMD warmth** (optional):
- If QMD tool is available, prefer it over grep for codebase queries within construct context
- Configurable via `.loa.config.yaml` `constructs.prefer_qmd: true`

**Acceptance criteria**:
- Greeting displays only when `constructs.ambient_greeting: true` in config
- Greeting includes active constructs with versions
- Greeting includes detected compositions
- Greeting includes available entry points
- Open threads surfaced with count and review prompt
- Threads older than 30 days auto-archived
- No greeting when no constructs installed (regardless of config)
- BATS test validates greeting assembly with mock index and threads

### FR-6: Capability Aggregation

**Problem**: Cycle-050 added `capabilities:` fields to individual skills, but there is no construct-level capability view. Hounfour and other routing systems need to know what a construct as a whole can do, not just individual skills.

**Solution**: Aggregate capabilities per construct from constituent skills.

**Aggregation rules**:
- For each construct in the index, read all skills' `capabilities:` fields from their SKILL.md frontmatter
- Union semantics: if ANY skill has `write_files: true`, the construct's aggregated `write_files: true`
- `execute_commands`: merge `allowed` lists across skills; if any skill has `execute_commands: true` (unrestricted), the aggregate is `true`
- `schema_version`: use the highest `schema_version` found across skills (all should be `1` from cycle-050)
- Skills without `capabilities:` field → skip (do not block aggregation)
- Result stored in `aggregated_capabilities:` in construct index entry

**Capability categories** (from cycle-050):
```yaml
aggregated_capabilities:
  schema_version: 1
  read_files: true|false
  search_code: true|false
  write_files: true|false
  execute_commands: true|false|{allowed: [...], deny_raw_shell: true}
  web_access: true|false
  user_interaction: true|false
  agent_spawn: true|false
  task_management: true|false
```

**Acceptance criteria**:
- Aggregated capabilities appear in construct index for each construct
- Union semantics verified: one `write_files: true` skill makes construct `write_files: true`
- Skills without capabilities field do not block aggregation
- `execute_commands` allowed lists merged correctly across skills
- BATS test validates aggregation with mock skills having varied capabilities

## 5. Technical & Non-Functional

### System Zone Authorization

FR-1 and FR-2 may require modifications to `.claude/scripts/constructs-loader.sh` and additions to `.claude/` (new script for index generation, CLAUDE.md instruction update). These are framework-internal changes to the construct loading pipeline, requiring authorized System Zone writes for this cycle. Safety hooks (`team-role-guard-write.sh`) must be accounted for in Agent Teams mode.

### Non-Functional Requirements

- **NFR-1**: Index generation < 500ms — parse `manifest.json` per pack, no network calls. Measured via `time` on 5 packs with 10 skills each.
- **NFR-2**: Name resolution adds < 50ms to agent response — YAML index lookup, not LLM inference. Measured by timing `yq` query on generated index.
- **NFR-3**: No new runtime dependencies — must work with existing `jq`, `yq`, `bash` toolchain. QMD is optional enhancement, not required.
- **NFR-4**: Progressive enhancement — all features degrade gracefully when construct data is sparse. A construct with only `name`, `slug`, `version`, and `skills` in its manifest must still be indexed and resolvable.
- **NFR-5**: Backward compatible — constructs without `writes`, `reads`, `gates`, `persona_path`, `quick_start`, or `composes_with` in their manifest still install, load, and appear in the index. Existing `constructs-loader.sh` behavior unchanged for current packs.
- **NFR-6**: Cross-platform — all scripts must work on macOS (Darwin) and Linux (Ubuntu CI), following `compat-lib.sh` patterns.

### State Files

| File | Zone | Purpose | Lifecycle |
|------|------|---------|-----------|
| `.run/construct-index.yaml` | State (.run/) | Construct index | Generated on session start, regenerated on pack change |
| `.run/archetype.yaml` | State (.run/) | Active operator mode | Written on mode activation, cleared on deactivation |
| `.run/open-threads.jsonl` | State (.run/) | Open discussion threads | Append-only, auto-archived after 30 days |

### Existing Infrastructure Touched

| File | Modification |
|------|-------------|
| `.claude/scripts/constructs-loader.sh` | Add `generate-index` subcommand (or call new script) |
| `.claude/scripts/constructs-install.sh` | Trigger index regeneration after install/update |
| `CLAUDE.md` | Add conditional construct name resolution instruction |
| `.loa.config.yaml.example` | Add `operator_os` and `constructs.ambient_greeting` examples |

### New Files

| File | Zone | Purpose |
|------|------|---------|
| `.claude/scripts/construct-index-gen.sh` | System | Index generation from installed packs |
| `.claude/scripts/construct-resolve.sh` | System | Name resolution and composition detection |
| `.claude/scripts/archetype-resolver.sh` | System | Operator OS mode activation/deactivation |

## 6. Scope

### In scope
- FR-1 through FR-6 as described above
- CLAUDE.md instruction for name resolution (FR-2)
- `.loa.config.yaml.example` updates for new config sections
- BATS tests for all new scripts

### Out of scope
- Network-side schema changes to `manifest.json` — that is loa-constructs#181, a companion RFC in a separate repo
- Construct certification or trust scoring
- Prescribing specific workflows or mental models — Operator OS provides the mechanism, not the opinion
- Building a specific Operator OS configuration — users define their own modes
- Construct marketplace or discovery beyond local packs
- QMD integration implementation (configuration only; QMD itself is external)
- InstructionsLoaded hook implementation — hook API depends on Claude Code upstream; instruction-based resolution is baseline

## 7. Risks & Dependencies

| Risk | Severity | Mitigation |
|------|----------|------------|
| Sparse construct schemas → L3/L4 features won't work without `writes`/`reads`/`gates` | Medium | Progressive enhancement: features degrade gracefully, FR-3 tells user honestly when no path overlap exists |
| CLAUDE.md token bloat from construct instruction | Medium | Conditional loading: instruction only injected when constructs are installed |
| InstructionsLoaded hook not yet available in Claude Code | Low | Instruction-based resolution is baseline (FR-2 tier 1); hook is optional enhancement |
| Composition path conflicts between constructs | Medium | Reuse `mount-conflict-detect.sh` pattern; warn, don't block |
| Operator OS complexity | Low | Simple schema: mode name + construct slugs + entry point. No inheritance, no nesting. |
| Capability aggregation on constructs without cycle-050 skills | Low | Skills without `capabilities:` field silently skipped; aggregation partial not broken |
| loa-constructs#181 (schema hygiene) not merged | Low | Soft dependency: L1 works with current `manifest.json` fields; new fields (`writes`, `reads`, `gates`, `persona_path`) are optional |
| Cycle-050 capabilities taxonomy changes after implementation | Low | `schema_version` field enables forward compatibility; aggregator checks version |

## 8. Dependencies

| Dependency | Type | Status | Impact if Missing |
|------------|------|--------|-------------------|
| Cycle-050 capabilities taxonomy (v1.65.0, PR #451) | Hard (FR-6) | Merged | FR-6 capability aggregation would have no source data |
| loa-constructs#181 (schema hygiene) | Soft (FR-1, FR-3) | Open | L1 works with current manifest; L3 composition limited without `writes`/`reads` |
| Claude Code InstructionsLoaded hook | Optional (FR-2 tier 2) | Upstream | Baseline instruction resolution still works; hook adds automatic injection |
| `mount-conflict-detect.sh` | Reuse pattern (FR-3) | Exists | Path conflict detection pattern already implemented |

## 9. Issue References

| Issue | Status | Disposition |
|-------|--------|-------------|
| #452 | Open | RFC — this PRD implements all 5 layers |
| loa-constructs#181 | Open | Companion RFC — schema hygiene, soft dependency |
| PR #451 | Merged | Cycle-050 capabilities taxonomy — FR-6 source data |

## 10. Design Decisions Log

| Decision | Rationale | Source |
|----------|-----------|--------|
| All 5 layers in one cycle | Layers are cohesive and build on each other; splitting would leave orphan infrastructure | Interview |
| YAML for construct index | Matches Loa convention (`.loa.config.yaml`, archetype schema); human-readable in `.run/` | Interview |
| Build from existing manifest.json fields | Don't invent new schemas when `manifest.json` already has `name`, `slug`, `version`, `skills`, `commands`, `events`, `tags` | Interview |
| Missing fields optional (progressive enhancement) | Current packs like `gtm-collective` lack `persona_path`, `writes`, `reads`, `gates` — these must not block adoption | Interview + manifest analysis |
| CLAUDE.md instruction as baseline name resolution | Works today without hook API dependency; hook is optional enhancement | Interview |
| Ambient greeting opt-in | Per hotel paradox: if you walk into a hotel and the butler announces your name without being asked, it's unsettling. Opt-in respects user agency. | Interview |
| Capability aggregation uses union semantics | A construct that can write files (via any skill) should be known to write files. Most-permissive is the correct aggregate for routing. | Interview + cycle-050 design |
| Most-restrictive-wins for gate merging in modes | If any construct in a mode requires review, the mode requires review. Safety gates should not be weakened by composition. | Design decision |
| Greeting format is flat text, not structured | The greeting is for human warmth, not machine parsing. Keep it simple. | Design decision |
