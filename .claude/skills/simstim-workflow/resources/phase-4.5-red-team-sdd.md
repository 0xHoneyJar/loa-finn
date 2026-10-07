# simstim phase-4.5-red-team-sdd (cycle-121 split from SKILL.md)

Execute this phase EXACTLY as written below when its trigger conditions (stated in SKILL.md) hold.

### Phase 4.5: RED TEAM SDD (Optional) [4.5/8]

Display: `[4.5/8] RED TEAM SDD - Generative adversarial security design...`

**Trigger conditions** (ALL must be true):
- `red_team.simstim.auto_trigger: true` in `.loa.config.yaml`
- `red_team.enabled: true` in `.loa.config.yaml`
- SDD exists and was reviewed by Flatline (Phase 4 complete)

**Skip conditions** (any triggers skip):
- `red_team.simstim.auto_trigger: false` (default)
- User chooses to skip when prompted
- SDD does not exist

**When triggered:**

1. Prompt user: "Run red team analysis on the SDD? [Y/n]"
2. If yes, invoke:
   ```bash
   .claude/scripts/flatline-orchestrator.sh \
     --doc grimoires/loa/sdd.md \
     --phase sdd \
     --mode red-team \
     --execution-mode standard \
     --json
   ```
3. Present attack summary:
   - CONFIRMED_ATTACK: Show details, require acknowledgment for severity >800
   - THEORETICAL: Show count
   - CREATIVE_ONLY: Show count
   - DEFENDED: Show count
4. Confirmed attacks generate additional sprint tasks:
   - Each CONFIRMED_ATTACK with severity >700 becomes a sprint task
   - Task description includes attack name, vector, and counter-design
   - Tasks are added to the sprint plan in Phase 5
5. Update state: `simstim-orchestrator.sh --update-phase red_team_sdd completed`

**If skipped:**
- Log skip reason to state file
- Continue to Phase 5

Proceed to Phase 5.
