# simstim phase-3.5-bridgebuilder-sdd (cycle-121 split from SKILL.md)

Execute this phase EXACTLY as written below when its trigger conditions (stated in SKILL.md) hold.

### Phase 3.5: BRIDGEBUILDER SDD (Design Review) [3.5/8]

Display: `[3.5/8] BRIDGEBUILDER SDD - Architectural design review...`

**Trigger conditions** (ALL must be true):
- `bridgebuilder_design_review.enabled: true` in `.loa.config.yaml`
- `simstim.bridgebuilder_design_review: true` in `.loa.config.yaml`
- SDD exists (`test -f grimoires/loa/sdd.md`)

If only one config flag is set, skip with warning:
"bridgebuilder_design_review.enabled and simstim.bridgebuilder_design_review disagree — design review will not run. Set both to true to enable."

**Skip conditions** (any triggers skip):
- Either config flag is false (default)
- User chooses to skip when prompted
- SDD does not exist

**When triggered:**

1. **Update state**: `simstim-orchestrator.sh --update-phase bridgebuilder_sdd in_progress`

2. **Load persona**: Read persona from path configured in
   `bridgebuilder_design_review.persona_path` (default: `.claude/data/bridgebuilder-persona.md`)

3. **Load lore** (if `bridgebuilder_design_review.lore_enabled: true`):
   Load lore entries using the same mechanism as Run Bridge Phase 3.1 step 3:
   read categories from `yq '.run_bridge.lore.categories[]' .loa.config.yaml`,
   then load matching entries from `grimoires/loa/lore/patterns.yaml` and
   `grimoires/loa/lore/visions.yaml`. Falls back gracefully to empty string
   if lore files do not exist.

   **Trajectory log** (after lore load):
   Log categories loaded, number of lore entries found, and whether fallback
   was used (e.g., "Lore loaded: 2 categories, 5 entries" or
   "Lore: no files found, proceeding without lore context").

4. **Read artifacts**:
   - SDD: `grimoires/loa/sdd.md` (full document; if >5K tokens, summarize per Run Bridge truncation strategy)
   - PRD: `grimoires/loa/prd.md` (for requirement traceability)
   - Discovery notes (optional, budget: 3K tokens total): Load
     `grimoires/loa/a2a/flatline/prd-review.json` (structured, predictable size)
     and the most recently modified file from `grimoires/loa/context/`. If total
     discovery notes exceed 3K tokens, truncate context/ content first (preserve
     flatline results). Skip silently if neither exists. These enable tracing the
     full problem → requirements → design reasoning chain.

5. **Generate review**: Using the Bridgebuilder persona and
   `.claude/data/design-review-prompt.md` template, evaluate the SDD against 6 dimensions:
   - Architectural Soundness
   - Requirement Coverage (PRD → SDD mapping)
   - Scale Alignment
   - Risk Identification
   - Frame Questioning (REFRAME)
   - Pattern Recognition (ecosystem lore)

   Produce dual-stream output:
   - **Stream 1**: Structured findings JSON inside `<!-- bridge-findings-start/end -->` markers
   - **Stream 2**: Insights prose (architectural meditations, FAANG parallels)

   Target completion within 120 seconds. If taking significantly longer,
   truncate insights prose and preserve findings JSON.

6. **Save review**:
   ```bash
   mkdir -p .run/bridge-reviews
   ```
   Write to `.run/bridge-reviews/design-review-{cycle}.md` with 0600 permissions.

7. **Parse findings**:
   ```bash
   .claude/scripts/bridge-findings-parser.sh \
     --input .run/bridge-reviews/design-review-{cycle}.md \
     --output .run/bridge-reviews/design-review-{cycle}.json
   ```

8. **HITL interaction** for each finding by severity:

   **REFRAME findings** (always presented):
   ```
   REFRAME: [title]
   [description]

   This questions the design framing, not the implementation.
   [A]ccept minor (modify SDD section)
   [A]ccept major (return to Architecture phase)
   [R]eject (log rationale)
   [D]efer (capture as vision)
   ```

   - Accept minor: Agent modifies the relevant SDD section in-place
   - Accept major: Mark SDD artifact as `needs_rework`, set
     `simstim-orchestrator.sh --update-phase architecture in_progress`,
     preserve REFRAME context to `.run/bridge-reviews/reframe-context.md`,
     return to Phase 3. **Circuit breaker**: Track rework count in
     `bridgebuilder_sdd.rework_count` (max 2). After 2 cycles,
     REFRAME findings are presented as accept-minor-only or auto-defer.
   - Reject: Log rationale to trajectory
   - Defer: Reclassify finding as VISION (preserving `original_severity: "REFRAME"`
     in metadata) and capture as vision entry in Step 9. This semantic transition
     reflects the state change: an active design question becomes a preserved
     insight for later exploration.

   **CRITICAL findings** (mandatory acknowledgment):
   ```
   CRITICAL: [title]
   [description]
   Design cannot satisfy a P0 requirement as specified.

   [A]ccept (modify SDD) / [R]eturn to Architecture / [R]eject (with rationale)
   ```
   No Defer option — CRITICAL findings demand a decision, not deferral.

   **HIGH/MEDIUM findings**:
   ```
   [severity]: [title]
   [description]
   Suggested change: [suggestion]

   [A]ccept (modify SDD) / [R]eject / [D]efer
   ```

   **SPECULATION findings**:
   ```
   SPECULATION: [title]
   [description]

   Architectural alternative to consider.
   [A]ccept (incorporate into SDD) / [D]efer (capture as vision)
   ```

   **LOW findings** (informational, no action required):
   ```
   LOW: [title]
   [description]
   Minor suggestion — displayed for awareness.
   ```

   **PRAISE findings**: Display to user (no action needed)

   **VISION findings**: Auto-capture to vision registry (no user interaction)

9. **Vision capture** (if any VISION/SPECULATION findings — including
   deferred REFRAMEs reclassified as VISION in Step 8 — and
   `bridgebuilder_design_review.vision_capture: true`):
   ```bash
   .claude/scripts/bridge-vision-capture.sh \
     --findings .run/bridge-reviews/design-review-{cycle}.json \
     --bridge-id "design-review-{simstim_id}" \
     --iteration 1 \
     --output-dir grimoires/loa/visions
   ```
   Note: `--pr` is omitted (optional argument). `--bridge-id` uses a
   design-review-prefixed identifier for provenance tracking.

   **Trajectory log** (after vision capture):
   Log event name (`design_review_vision_capture`), number of vision entries
   created, bridge-id, and findings count by severity.

10. **Update artifact checksum** (if SDD was modified):
    ```bash
    .claude/scripts/simstim-state.sh add-artifact sdd grimoires/loa/sdd.md
    ```

11. **Complete phase**:
    ```bash
    .claude/scripts/simstim-orchestrator.sh --update-phase bridgebuilder_sdd completed
    ```

**If skipped** (config disabled or mismatch):
- Log skip reason to state file
- Continue to Phase 4

**If Phase 3.5 fails** (review generation error, parse failure, etc.):
- Log error to trajectory with stack context
- Mark phase as `skipped` (not `failed`) to avoid blocking
- Display warning: "Design review failed: [reason]. Continuing to Phase 4."
- Continue to Phase 4 — design review is advisory, not blocking

Proceed to Phase 4.
