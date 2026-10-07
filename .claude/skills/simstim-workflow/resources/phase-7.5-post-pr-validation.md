# simstim phase-7.5-post-pr-validation (cycle-121 split from SKILL.md)

Execute this phase EXACTLY as written below when its trigger conditions (stated in SKILL.md) hold.

### Phase 7.5: POST-PR VALIDATION [7.5/8] (v1.25.0)

Display: `[7.5/8] POST-PR VALIDATION - Fresh-eyes review...`

**This phase runs automatically via post-pr-orchestrator.sh when `post_pr_validation.enabled: true`.**

The post-PR validation loop includes:

1. **POST_PR_AUDIT**: Consolidated audit on PR changes
   - Auto-fixable issues enter fix loop (max 5 iterations)
   - Circuit breaker: same finding 3x = escalate
   - Creates `.PR-AUDITED` marker

2. **CONTEXT_CLEAR**: Checkpoint and fresh context
   - Saves checkpoint to NOTES.md Session Continuity
   - Logs to trajectory JSONL
   - Displays instructions:
     ```
     To continue with fresh-eyes E2E testing:
       1. Run: /clear
       2. Run: /simstim --resume
     ```

3. **E2E_TESTING**: Fresh-eyes testing
   - Runs build and tests with clean context
   - Fix loop for failures (max 3 iterations)
   - Circuit breaker: same failure 2x = escalate
   - Creates `.PR-E2E-PASSED` marker

4. **FLATLINE_PR** (optional): Multi-model PR review
   - Runs if `flatline_review.enabled: true`
   - Cost: ~$1.50
   - Uses HITL mode (blockers prompt user, not auto-halt)
   - Creates `.PR-VALIDATED` marker

5. **BRIDGEBUILDER_REVIEW** (optional, Amendment 1 — cycle-053): Post-PR Bridgebuilder closed-loop
   - Runs if `post_pr_validation.phases.bridgebuilder_review.enabled: true`
   - Invokes `bridge-orchestrator.sh` (depth 5 by default) to post multi-model review to PR
   - `post-pr-triage.sh` classifies findings and logs reasoning per finding
   - BLOCKER findings → queued to `.run/bridge-pending-bugs.jsonl` for auto-dispatch
   - HIGH findings → logged to `grimoires/loa/a2a/trajectory/bridge-triage-*.jsonl`
   - PRAISE findings → queued to `.run/bridge-lore-candidates.jsonl` for lore mining
   - Per HITL design decision #1: autonomous mode acts with logged reasoning, no HITL gate
   - Closes the feedback loop between external Bridgebuilder and Loa internal state
   - See `grimoires/loa/proposals/close-bridgebuilder-loop.md` for full design rationale

**Full phase sequence**: `POST_PR_AUDIT → CONTEXT_CLEAR → E2E_TESTING → FLATLINE_PR → BRIDGEBUILDER_REVIEW → READY_FOR_HITL`

**Resume from context clear:**

When user runs `/simstim --resume` after context clear:

```bash
# Check post-PR state
current_phase=$(post-pr-state.sh get state)
if [[ "$current_phase" == "CONTEXT_CLEAR" ]]; then
  # Continue from E2E_TESTING
  post-pr-orchestrator.sh --resume --pr-url "$PR_URL"
fi
```

**Final states:**
- `READY_FOR_HITL`: All validations passed, PR ready for human review
- `HALTED`: Validation failed, check `halt_reason` field

