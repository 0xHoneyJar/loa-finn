# discovering-requirements: Vision Registry procedure (cycle-121 split from SKILL.md)

Execute these steps EXACTLY as written when `vision_registry.enabled: true`.

## Step 0.5: Vision Registry Loading (v1.42.0)

**Purpose**: Surface relevant captured visions from previous bridge reviews to inform planning.

### Check Configuration

```bash
vr_enabled=$(yq eval '.vision_registry.enabled // false' .loa.config.yaml 2>/dev/null || echo "false")
```

If `vision_registry.enabled` is `false` or absent: **skip this step entirely** — no mention to user, no code runs.

### Derive Work Context Tags

When enabled, derive tags from available context in priority order:

1. **Sprint file paths** (if `grimoires/loa/sprint.md` exists): Extract `**File**: \`...\`` patterns and map through `vision_extract_tags()` path-to-tag rules
2. **User request keywords**: Match against controlled vocabulary (`architecture`, `security`, `constraints`, `multi-model`, `testing`, `philosophy`, `orchestration`, `configuration`, `eventing`)
3. **PRD section headers** (if `grimoires/loa/prd.md` exists): Map headers to tags (e.g., "Security" → `security`)

Tags are deduplicated and sorted before matching.

### Query Vision Registry

```bash
visions=$(.claude/scripts/vision-registry-query.sh \
  --tags "$work_tags" \
  --status "$(yq eval '.vision_registry.status_filter | join(",")' .loa.config.yaml 2>/dev/null || echo 'Captured,Exploring')" \
  --min-overlap "$(yq eval '.vision_registry.min_tag_overlap // 2' .loa.config.yaml 2>/dev/null || echo '2')" \
  --max-results "$(yq eval '.vision_registry.max_visions_per_session // 3' .loa.config.yaml 2>/dev/null || echo '3')" \
  --include-text \
  --json)
```

### Route by Mode

**Shadow mode** (`vision_registry.shadow_mode: true`):

```bash
# Log silently — do NOT present to user
.claude/scripts/vision-registry-query.sh \
  --tags "$work_tags" \
  --shadow \
  --shadow-cycle "$(yq eval '.active_cycle' grimoires/loa/ledger.json 2>/dev/null)" \
  --shadow-phase "plan-and-analyze" \
  --json > /dev/null
```

- Results logged to `grimoires/loa/a2a/trajectory/vision-shadow-{date}.jsonl`
- Shadow cycle counter incremented in `grimoires/loa/visions/.shadow-state.json`
- If graduation ready (cycles >= threshold AND matches > 0), present graduation prompt (see Step 0.5b)

**Active mode** (`vision_registry.shadow_mode: false`):

Present matched visions to user using the template below, then process user decisions.

### Vision Presentation Template (Active Mode)

For each matched vision, present using the presentation template in `resources/templates/vision-registry-templates.md`.

**IMPORTANT**: The relevance explanation is template-based (tag match + score), NOT LLM-generated. Do not fabricate a narrative about why the vision is relevant — state the matched tags and score.

### Process User Decisions

For each vision the user responds to:

| Choice | Action |
|--------|--------|
| **Explore** | Call `vision_update_status(vision_id, "Exploring", visions_dir)`. Record reference via `vision_record_ref()`. Log choice to trajectory JSONL. |
| **Defer** | Log choice to trajectory JSONL. No status change. |
| **Skip** | Log choice to trajectory JSONL. No status change. |

Log format (append to `grimoires/loa/a2a/trajectory/vision-decisions-{date}.jsonl`):
```json
{
  "timestamp": "ISO8601",
  "cycle": "cycle-NNN",
  "phase": "plan-and-analyze",
  "vision_id": "vision-NNN",
  "decision": "explore|defer|skip",
  "score": N,
  "matched_tags": ["tag1", "tag2"]
}
```

### Step 0.5b: Shadow Graduation Prompt

When the query script returns `graduation.ready: true`, present the shadow-graduation prompt in `resources/templates/vision-registry-templates.md`.

On "Enable active mode": Update config via `yq eval '.vision_registry.shadow_mode = false' -i .loa.config.yaml`

---


## Step 7.5: Vision-Inspired Requirement Proposals (Experimental, v1.42.0)

**Purpose**: When a user chose "Explore" for a vision in Step 0.5, synthesize it with the work context to propose additional requirements the user may not have considered.

**Gate**: This step ONLY runs when ALL conditions are met:
1. `vision_registry.enabled: true` in `.loa.config.yaml`
2. `vision_registry.propose_requirements: true` in `.loa.config.yaml` (default: `false`)
3. At least one vision was marked "Explore" during Step 0.5

If any condition is false: **skip this step silently**.

### Load Explored Visions

For each vision the user chose "Explore" in Step 0.5:

```bash
entry_file="grimoires/loa/visions/entries/${vision_id}.md"
```

Read the full entry file including `## Insight`, `## Potential`, and `## Connection Points` sections.

### Synthesize Proposals

For each explored vision, synthesize with the work context gathered from Phases 1-7 to propose 1-3 requirements. Each proposal must:

1. **Trace to source vision**: `[VISION-INSPIRED: vision-NNN]`
2. **Connect to work context**: Explain how this vision relates to what the user is building
3. **Be concrete and actionable**: Not vague — propose specific functional or non-functional requirements
4. **Respect scope**: Do not propose requirements that contradict user's stated scope

### Present Proposals

Present using the vision-inspired proposals specimen in `resources/templates/vision-registry-templates.md`.

### Process Decisions

| Choice | Action |
|--------|--------|
| **Accept** | Include in PRD under "## Vision-Inspired Requirements" section. Call `vision_update_status(vision_id, "Proposed", visions_dir)`. Record reference. |
| **Modify** | User edits the requirement text. Include modified version in PRD. Status → Proposed. Record reference. |
| **Reject** | Do not include. Log rejection reason to trajectory JSONL. No status change. |

Log all decisions to `grimoires/loa/a2a/trajectory/vision-proposals-{date}.jsonl`:
```json
{
  "timestamp": "ISO8601",
  "cycle": "cycle-NNN",
  "vision_id": "vision-NNN",
  "proposal_title": "short title",
  "decision": "accept|modify|reject",
  "rejection_reason": "optional — only for reject"
}
```

### PRD Integration

Accepted/modified proposals go in a dedicated PRD section — use the PRD-integration specimen in `resources/templates/vision-registry-templates.md`.

This section is clearly separated from user-driven requirements and carries full provenance.

---

