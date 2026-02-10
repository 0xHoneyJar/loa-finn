---
name: ground-truth
description: Generate factual, code-grounded GTM documents with BridgeBuilder voice and deterministic verification
context: fork
agent: general-purpose
allowed-tools: Read, Grep, Glob, Bash(.claude/scripts/ground-truth/*)
danger_level: moderate
enhance: false
---

# Ground Truth — Factual GTM Document Generation

You are generating factual, code-grounded GTM documents using the BridgeBuilder voice.
Every claim must be verifiable. Every citation must be real. The verification layer is
entirely deterministic — shell scripts check your work. You cannot hallucinate past the firewall.

> *"Mechanism over adjective. Evidence over assertion. Teaching over selling."*

## Pre-flight

### Check registries exist

```bash
for f in features.yaml limitations.yaml capability-taxonomy.yaml; do
  if [[ ! -f "grimoires/loa/ground-truth/$f" ]]; then
    echo "ERROR: Missing registry: grimoires/loa/ground-truth/$f"
    echo ""
    echo "Run: .claude/scripts/ground-truth/bootstrap-registries.sh"
    echo "Then edit the files and commit before running /ground-truth."
    exit 1
  fi
done
echo "Registries OK"
```

### Parse arguments

Supported flags:
- `--type capability-brief` (default)
- `--type architecture-overview`
- `--incremental` — Only regenerate stale sections (v2.0)

```
DOC_TYPE="${1:-capability-brief}"
OUTPUT_DIR="grimoires/loa/ground-truth"
INCREMENTAL=false
# Parse --incremental flag from arguments
```

---

## Stage 1: GROUND — Load codebase reality

Load context in priority order. **Tier A is non-negotiable.**

### Tier A: Hard Constraints (load first, always)

1. **Template** for the selected document type:
   - Read: `.claude/skills/ground-truth/resources/templates/${DOC_TYPE}.md`
   - This defines required sections, provenance expectations, and structure

2. **Provenance specification**:
   - Read: `.claude/skills/ground-truth/resources/provenance-spec.md`
   - This defines the exact tag syntax, citation rules, and evidence anchor format

3. **Quality gate requirements** (know what will be checked):
   - Citation verification: every `file:line` must resolve to a real, tracked file
   - Banned terms: zero tolerance for superlatives
   - Provenance tags: ≥95% coverage, class-specific citation rules enforced
   - Evidence anchors: every CODE-FACTUAL paragraph needs `<!-- evidence: ... -->`

### Tier B: Evidence (load in priority order, within token budget)

4. **Code reality** — highest priority evidence:
   - Read: `grimoires/loa/reality/index.md` (if available from /ride)
   - Or: Run inventory-modules.sh to enumerate modules
   - Read actual source files for specific claims

5. **Registry files**:
   - Read: `grimoires/loa/ground-truth/features.yaml`
   - Read: `grimoires/loa/ground-truth/limitations.yaml`
   - Read: `grimoires/loa/ground-truth/capability-taxonomy.yaml`

6. **Grimoire state** (if available):
   - Read: `grimoires/loa/NOTES.md`
   - Read: `grimoires/loa/decisions.yaml` (if exists)

7. **Voice template**:
   - Read: `.claude/skills/ground-truth/resources/voice/bridgebuilder-gtm.md`

8. **Analogy bank** (if available):
   - Read: `.claude/skills/ground-truth/resources/analogies/analogy-bank.yaml`
   - Each analogy has a `confidence` field (high/moderate):
     - **high**: Use directly — "X works like Y" with full structural comparison
     - **moderate**: Use with qualifier — "in some ways similar to Y" or "loosely parallels Y"
   - Staleness of high-confidence analogies is a more urgent signal than moderate ones

### Token budget

Target: 13,500–28,000 tokens for generation context.
- Tier A: ~3,000 tokens (templates + provenance spec)
- Tier B reality: ~8,000 tokens (code + registries)
- Tier B voice: ~1,500 tokens (voice template + analogies)
- Remaining: generation prompt + output space

If context exceeds budget, truncate Tier B items from lowest priority up.

---

## Stage 2: INVENTORY — Run shell scripts

Run inventory and extraction scripts to gather structured data:

```bash
# Module inventory
.claude/scripts/ground-truth/inventory-modules.sh --json

# Limitations extraction
.claude/scripts/ground-truth/extract-limitations.sh --json
```

Use the Read tool to inspect specific source files for claims you'll make.
Do NOT use arbitrary Bash to read files — use the Read tool.

---

## Stage 3: GENERATE — Produce the document

### Incremental mode (v2.0)

When `--incremental` is set, only regenerate sections that are stale:

```bash
# Check which sections need regeneration
staleness=$(.claude/scripts/ground-truth/check-staleness.sh "${OUTPUT_DIR}/${DOC_TYPE}.md" --json)
stale_count=$(echo "$staleness" | jq -r '.stale_count')

if [[ "$stale_count" -eq 0 ]]; then
  echo "No stale sections — document is current"
  # Skip to Stage 6 (OUTPUT)
fi

# Get list of stale section headings
stale_headings=$(echo "$staleness" | jq -r '.stale_sections[].heading')
```

When regenerating incrementally:
1. Read the existing document
2. Only rewrite sections whose headings appear in `stale_headings`
3. Preserve all non-stale sections byte-for-byte
4. Run VERIFY on the **full document** after partial regeneration (not just stale sections)

If `--incremental` is NOT set, generate the full document as before:

Generate the document following the template structure exactly.

### Generation rules

1. **Every CODE-FACTUAL paragraph MUST**:
   - Be preceded by `<!-- provenance: CODE-FACTUAL -->`
   - Contain at least one backtick `file:line` citation
   - Be followed by `<!-- evidence: symbol=X, literal="Y" -->` with tokens from the cited range
   - Use the Read tool to verify the cited lines BEFORE writing the citation

2. **Every HYPOTHESIS paragraph MUST**:
   - Be preceded by `<!-- provenance: HYPOTHESIS -->`
   - Start with an epistemic marker ("We hypothesize", "We are exploring", etc.)

3. **Every EXTERNAL-REFERENCE MUST** cite a URL or paper reference

4. **BridgeBuilder voice**:
   - At least 1 FAANG/bluechip analogy per major section (## heading)
   - 70/30 rule: 70% mechanism, 30% analogy
   - Never force an analogy — prefer omission over inaccuracy

5. **Banned terms**: Never use any term from `banned-terms.txt`

6. **Citation encoding**: Paths must be repo-relative, matching `^[a-zA-Z0-9_./-]+$`

### Output

Write the generated document to:
```
grimoires/loa/ground-truth/${DOC_TYPE}.md
```

---

## Stage 4: VERIFY — Deterministic quality gates

Run the full quality gate suite. **No LLM in this path.**

```bash
.claude/scripts/ground-truth/quality-gates.sh "grimoires/loa/ground-truth/${DOC_TYPE}.md" --json
```

If exit code is 0: proceed to Stage 6 (OUTPUT).
If exit code is 1: proceed to Stage 5 (REPAIR).

---

## Stage 5: REPAIR — Fix verification failures (max 3 iterations)

When quality gates fail, you receive a JSON failure report. Fix each failure.

### Repair interface contract

- **Input**: Failure JSON from quality-gates.sh + the generated markdown draft
- **Allowed edits**: ONLY the generated markdown at `grimoires/loa/ground-truth/${DOC_TYPE}.md`
- **Method**: Full rewrite of the generated markdown file
- **Guard**: Do NOT edit source code, registries, or any file outside `grimoires/loa/ground-truth/`

### Repair rules

1. **Fix the citation, not the claim** — find the correct `file:line` for the real code
2. **If the claim is wrong** — update both the claim and the citation
3. **If a claim cannot be grounded** — convert from CODE-FACTUAL to HYPOTHESIS with epistemic marker
4. **Never fabricate a citation** to make the verifier pass
5. **Use the Read tool** to inspect actual source files during repair

### Repair loop

```
iteration = 0
while iteration < 3:
  Fix failures based on JSON report
  Rewrite document
  Run quality-gates.sh again
  If PASS: break
  iteration++

If iteration == 3 and still failing:
  HALT with detailed failure report
  Save last draft for manual review
```

After each repair, re-run Stage 4 (VERIFY).

---

## Stage 6: OUTPUT — Write and stamp

After verification passes:

### Stamp freshness metadata

```bash
.claude/scripts/ground-truth/stamp-freshness.sh "grimoires/loa/ground-truth/${DOC_TYPE}.md"
```

### Confirm output

Report to the user:
- Document path
- Citation count (verified)
- Provenance coverage percentage
- Warning count (if any)
- Generation timestamp

---

## Stage 7: MANIFEST — Update generation manifest

```bash
.claude/scripts/ground-truth/write-manifest.sh "grimoires/loa/ground-truth/${DOC_TYPE}.md" \
  --citations ${CITATION_COUNT} \
  --warnings ${WARNING_COUNT} \
  --gates pass
```

This creates/updates `grimoires/loa/ground-truth/generation-manifest.json` with:
- Document path, generation timestamp, HEAD SHA
- Citation count, quality gate result, warning count
- Registry SHAs (features, limitations, ride)

---

## Beads Integration (Optional)

If `br` (beads_rust) is available, track generation as a beads task:

```bash
if command -v br &>/dev/null; then
  # Create task before generation
  br create --label "ground-truth:${DOC_TYPE}" --status in_progress

  # On success
  br close <task-id> --reason "Generated ${DOC_TYPE} with ${CITATION_COUNT} verified citations"

  # On repair loop exhaustion
  br update <task-id> --status blocked --comment "Repair loop exhausted after 3 iterations"
fi
```

If `br` is not available, skip silently — beads integration is optional.

---

## Error Handling

| Failure | Recovery |
|---------|----------|
| /ride output missing | Prompt user to run `/ride` first |
| /ride output stale (>7 days) | Warn user; proceed with stale data or prompt re-ride |
| Registry files missing | Fail fast with bootstrap command |
| Quality gate fails | Enter REPAIR loop (max 3 iterations) |
| Repair loop exhausted | HALT with failure report; save last draft |
| yq not installed | Warn; skip registry-consistency gate |

## Circuit Breaker

If the same document type fails verification 3 consecutive times across separate invocations,
log a warning to `grimoires/loa/NOTES.md`:

```markdown
## Blockers

- [{date}] ground-truth: {doc-type} failed verification 3 consecutive times.
  Last failure: {gate} on {citation}.
  Likely cause: /ride reality is stale or features.yaml is out of date.
  Action: Re-run /ride and review features.yaml.
```
