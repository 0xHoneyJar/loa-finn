# Software Design Document: Ground Truth — Factual GTM Skill Pack

> **Version**: 1.1.0
> **Date**: 2026-02-10
> **Author**: @janitooor
> **Status**: Draft
> **PRD**: `grimoires/loa/prd-ground-truth.md` v1.1.0 (GPT-5.2 APPROVED)
> **Grounding**: Skill architecture analysis (17 existing skills), `/ride` output format, BridgeBuilder persona spec (loa-finn#24)

---

## 1. Executive Summary

Ground Truth is a Loa skill pack that generates factual, code-grounded GTM documents using the BridgeBuilder persona voice. It consists of:

1. **A composite Loa skill** (`.claude/skills/ground-truth/SKILL.md`) with a 7-stage generation pipeline
2. **Deterministic shell scripts** (`.claude/scripts/ground-truth/`) for citation verification, banned-term scanning, and provenance validation
3. **Curated resource files** (templates, voice guidelines, analogy bank, cross-domain references)
4. **Team-maintained registry files** (`grimoires/loa/ground-truth/features.yaml`, `limitations.yaml`)

The architecture follows a **generate-then-verify** pattern: the LLM produces documents grounded in `/ride` codebase analysis, then deterministic scripts validate every citation before output is emitted. Failed citations halt generation and trigger an LLM repair loop (max 3 iterations).

```
┌─────────────────────────────────────────────────────────┐
│                    /ground-truth                         │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │  GROUND   │→│ INVENTORY │→│ GENERATE  │              │
│  │ (/ride)   │  │  (shell)  │  │  (LLM)   │              │
│  └──────────┘  └──────────┘  └─────┬─────┘              │
│                                     │                    │
│                              ┌──────▼──────┐             │
│                              │   VERIFY     │             │
│                              │ (shell, NO   │             │
│                              │  LLM)        │             │
│                              └──────┬──────┘             │
│                                     │                    │
│                          ┌──────────┤                    │
│                          │     PASS? │                    │
│                     YES ◄┤          ├► NO                │
│                          │          │                    │
│                   ┌──────▼──┐  ┌────▼─────┐             │
│                   │  OUTPUT  │  │  REPAIR   │             │
│                   │ (write)  │  │  (LLM,    │             │
│                   └─────────┘  │  max 3)   │             │
│                                └──────┬────┘             │
│                                       │ → back to VERIFY │
└───────────────────────────────────────┘
```

**Key design principle**: The verification layer is entirely deterministic — shell scripts, regex, `git ls-files`, `sed`. No LLM in the verification path. This prevents the system from "hallucinating its own verification pass."

---

## 2. Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Skill definition | SKILL.md (Loa convention) | Follows existing 17-skill pattern; no custom runtime |
| Verification scripts | Bash + jq | Deterministic, testable independently, no LLM variability |
| Codebase grounding | `/ride` skill output | Existing infrastructure; outputs module inventory with `file:line` citations |
| Voice layer | BridgeBuilder prompt template | Extracted from loa-finn#24; injected as system context |
| Registry format | YAML (features.yaml, limitations.yaml) | Human-editable, parseable by yq v4+, compatible with existing .loa.config.yaml tooling |
| Output format | GitHub-flavored Markdown | Compatible with Docusaurus, MkDocs, raw GitHub rendering |
| Quality gate orchestration | quality-gates.sh | Aggregates all verification scripts into single pass/fail |
| Generation metadata | JSON (generation-manifest.json) | Machine-readable; includes HEAD SHA, timestamps, checksums |

### Dependencies

```
/ground-truth (skill)
├── /ride (skill, existing) .......... Codebase grounding
├── jq (CLI, installed) .............. JSON parsing in scripts
├── yq v4+ (CLI, installed) .......... YAML parsing for registries
├── git (CLI, installed) .............. File existence check via ls-files
├── grep/sed (CLI, installed) ........ Citation extraction, pattern matching
└── BridgeBuilder persona (resource) .. Voice template from #24
```

No new npm packages. No new TypeScript code in `src/`. The entire skill pack is SKILL.md + shell scripts + resource files.

---

## 3. Component Design

### 3.1 Directory Structure

```
.claude/skills/ground-truth/
├── SKILL.md                              # Skill definition with 7-phase workflow
└── resources/
    ├── templates/
    │   ├── capability-brief.md           # Structure template with section requirements
    │   ├── architecture-overview.md      # Component + layer template
    │   ├── feature-inventory.md          # Matrix template with column definitions
    │   ├── thinking-in-loa.md            # Mental model template (Phase 2)
    │   ├── tradeoffs.md                  # Self-assessment template (Phase 2)
    │   ├── release-narrative.md          # Per-release template (Phase 2)
    │   └── research-brief.md             # Theoretical foundations template (Phase 3)
    ├── voice/
    │   └── bridgebuilder-gtm.md          # BridgeBuilder voice guidelines for GTM docs
    ├── analogies/
    │   └── analogy-bank.yaml             # Curated FAANG/bluechip parallels
    └── cross-domain/
        └── reference-sets.md             # Cross-domain reference library (#247)

.claude/scripts/ground-truth/
├── verify-citations.sh                   # Citation file:line verifier
├── scan-banned-terms.sh                  # Banned superlative scanner
├── check-provenance.sh                   # Provenance tag validator
├── quality-gates.sh                      # Gate orchestrator (runs all checks)
├── inventory-modules.sh                  # Module enumeration from src/
├── extract-limitations.sh                # TODO/FIXME/limitation extractor
└── stamp-freshness.sh                    # HEAD SHA + timestamp stamper

grimoires/loa/ground-truth/
├── features.yaml                         # Feature status registry (TEAM-CURATED)
├── limitations.yaml                      # Known limitations (TEAM-CURATED)
├── banned-terms.txt                      # Banned superlative list
├── capability-taxonomy.yaml              # Top-level capability categories
├── generation-manifest.json              # Generation metadata (AUTO-GENERATED)
├── capability-brief.md                   # Generated output
├── architecture-overview.md              # Generated output
├── feature-inventory.md                  # Generated output
├── thinking-in-loa.md                    # Generated output (Phase 2)
├── tradeoffs.md                          # Generated output (Phase 2)
├── release-narrative-{version}.md        # Generated output (Phase 2)
└── research-brief.md                     # Generated output (Phase 3)
```

### 3.2 SKILL.md Design

The skill follows the Loa skill architecture pattern:

```yaml
---
name: ground-truth
description: Generate factual, code-grounded GTM documents with BridgeBuilder voice
context: fork
agent: general-purpose
allowed-tools: Read, Grep, Glob, Bash(.claude/scripts/ground-truth/*)
zones:
  system: read
  state: read-write
  app: read-only
danger_level: moderate
enhance: false
---
```

**Key design decisions in SKILL.md**:

| Decision | Rationale |
|----------|-----------|
| `context: fork` | Isolates from main conversation; large context needed for /ride output |
| `agent: general-purpose` | Needs Read + Grep + Glob + Bash for analysis and generation |
| `allowed-tools` scoped to wrapper scripts only | All shell commands (`stat`, `jq`, `yq`, `git`, `sed`, `grep`, `awk`) run INSIDE wrapper scripts. Agent only invokes `.claude/scripts/ground-truth/*.sh`. This keeps bash restricted while allowing scripts to call whatever they need internally. |
| Agent reads files via Read tool | During REPAIR phase, agent uses Read tool (not bash sed) to inspect cited files. Read tool is always permitted. |
| `app: read-only` | Reads `src/` for citation verification but never modifies application code |
| `enhance: false` | Prompt is already heavily structured; enhancement would interfere |
| `danger_level: moderate` | Reads codebase + writes to grimoires; no external API calls or deploys |

**Tool permission model**: The agent calls wrapper scripts for all deterministic operations. During REPAIR, the agent uses the Read tool to inspect actual file contents and fix citations. This avoids expanding bash permissions while keeping the repair loop functional.

### 3.3 Shell Script Specifications

#### 3.3.1 `verify-citations.sh`

The core verification script. Deterministic, no LLM.

```
Usage: verify-citations.sh <markdown-file> [--json] [--strict]

Input:  A generated markdown file with file:line citations
Output: JSON report of citation verification results

Checks (in order):
  1. EXTRACT — Regex-extract all citation patterns:
     Pattern: backtick-wrapped paths matching `path/file.ext:NN` or `path/file.ext:NN-MM`
     Also handles: `src/foo.ts:47-89`, `src/bar/baz.ts:12`

  2. PATH_SAFETY — MUST run before any file read (security boundary):
     Reject paths containing: "..", leading "/", control chars (\x00-\x1f)
     Require: git ls-files -z -- <path> exact match (NUL-delimited)
     Resolve to repo-relative path only
     Optional: enforce prefix allowlist (src/, grimoires/, packages/, tests/, deploy/)
     All downstream steps operate ONLY on the normalized, repo-relative path
     returned by PATH_SAFETY. Raw extracted paths are never passed to sed/cat/read.

  3. FILE_EXISTS — For each validated path:
     Run: git ls-files --error-unmatch <normalized_path> 2>/dev/null
     Pass: file is tracked in git
     Fail: file does not exist at HEAD
     (Redundant with PATH_SAFETY git ls-files check, retained as defense-in-depth)

  4. LINE_RANGE — For each validated path:line:
     Run: sed -n 'NNp' <normalized_path> or sed -n 'NN,MMp' <normalized_path>
     Extract the cited line(s)
     Store for evidence anchor matching

  5. EVIDENCE_ANCHOR — For each CODE-FACTUAL paragraph:
     The generator MUST emit an explicit evidence anchor comment:
     <!-- evidence: symbol=writeEntry, symbol=flock, literal="O_EXCL" -->
     The verifier parses these anchors and checks each token/literal
     against the cited line range content.
     Pass: ALL anchor tokens found in cited range
     Fail: Any anchor token missing from cited range

     NOTE: The generator is responsible for emitting accurate anchors.
     The verifier only checks anchors against extracted lines — it does NOT
     use heuristic NLP extraction from claim text. This makes the check
     fully deterministic.

Exit codes:
  0 — All citations verified
  1 — One or more citations failed
  2 — Input file not found or unreadable
  3 — Path safety violation detected

Output format (--json):
{
  "file": "grimoires/loa/ground-truth/capability-brief.md",
  "total_citations": 24,
  "verified": 22,
  "failed": 2,
  "failures": [
    {
      "citation": "src/persistence/wal.ts:47-89",
      "check": "EVIDENCE_ANCHOR",
      "anchor": "symbol=flock",
      "actual_lines": "export async function writeEntry(entry: WALEntry) {",
      "paragraph_context": "..."
    }
  ]
}
```

#### 3.3.2 `scan-banned-terms.sh`

```
Usage: scan-banned-terms.sh <markdown-file> [--terms-file <path>] [--json]

Input:  Generated markdown + banned terms list
Default terms file: grimoires/loa/ground-truth/banned-terms.txt
Output: JSON report of banned term occurrences

Logic:
  Step 1 — PREPROCESS: Strip non-prose content using awk state machine:
    - State IN_FRONTMATTER: lines between opening/closing `---`
    - State IN_FENCE: lines between opening/closing ``` (backtick fence)
    - State IN_HTML_COMMENT: lines between `<!--` and `-->`
    - State IN_BLOCKQUOTE: lines starting with `^> ` (direct quotations)
    Rules:
      ^---$              → toggle IN_FRONTMATTER
      ^```               → toggle IN_FENCE
      <!--               → enter IN_HTML_COMMENT
      -->                → exit IN_HTML_COMMENT
      ^>                 → IN_BLOCKQUOTE (single line)
    Output: temp file with only prose paragraphs

  Step 2 — SCAN: Build single combined regex from banned-terms.txt:
    terms=$(paste -sd'|' banned-terms.txt)
    grep -i -n -E "$terms" <preprocessed-file>

  Step 3 — REPORT: Map line numbers back to original file

Exit codes:
  0 — No banned terms found
  1 — Banned terms found
  2 — Input file not found or unreadable
```

#### 3.3.3 `check-provenance.sh`

```
Usage: check-provenance.sh <markdown-file> [--json]

Input:  Generated markdown with <!-- provenance: CLASS --> tags
Output: JSON report of provenance audit

Paragraph detection uses a deterministic awk state machine with explicit states:

  States: NORMAL, IN_FRONTMATTER, IN_FENCE, IN_TABLE, IN_HTML_COMMENT
  Transitions:
    ^---$         → toggle IN_FRONTMATTER
    ^```          → toggle IN_FENCE
    ^\|.*\|       → IN_TABLE (while consecutive pipe-rows)
    <!--          → IN_HTML_COMMENT (unless provenance tag)
    -->           → exit IN_HTML_COMMENT
    ^#{1,6}\s     → heading (exempt from tagging)
    ^-\s|^\*\s    → list item (exempt — provenance covers the parent section)
    blank line    → paragraph boundary

  Taggable surface: Only paragraphs in NORMAL state that start with a
  non-whitespace, non-markdown-control character. Lists, tables, headings,
  code blocks, and HTML comments are exempt.

Checks:
  1. TAG_COVERAGE — Every taggable paragraph has a preceding
     `<!-- provenance: CLASS -->` comment (within 3 lines above it)
     Pass: 100% of taggable paragraphs covered
     Fail: Any untagged taggable paragraph

  2. CODE_FACTUAL_CITATION — Every CODE-FACTUAL paragraph contains
     at least one file:line citation pattern AND at least one
     `<!-- evidence: ... -->` anchor
     Pass: both patterns found
     Fail: CODE-FACTUAL without citation or evidence anchor

  3. HYPOTHESIS_MARKER — Every HYPOTHESIS paragraph contains an
     epistemic marker ("we are exploring", "we hypothesize", "we observe",
     "this suggests", "preliminary")
     Pass: marker found
     Fail: HYPOTHESIS stated as fact

  4. EXTERNAL_REFERENCE_CITATION — Every EXTERNAL-REFERENCE paragraph
     contains a URL, DOI, or book reference
     Pass: external citation found
     Fail: external assertion without source

Exit codes:
  0 — All provenance checks pass
  1 — One or more checks failed
  2 — Input file not found or unreadable

Golden test fixtures: `.claude/scripts/ground-truth/test-fixtures/`
containing sample markdown with expected pass/fail provenance results.
These fixtures are checked during script development to prevent regressions.
```

#### 3.3.4 `quality-gates.sh`

```
Usage: quality-gates.sh <markdown-file> --type <doc-type> [--json]

Orchestrator that runs all quality gates and aggregates results.

Sequence:
  1. scan-banned-terms.sh → BLOCKING
  2. check-provenance.sh → BLOCKING
  3. verify-citations.sh --strict → BLOCKING
  4. Check for "Limitations" / "Where We're Not a Fit" section → BLOCKING
  5. Check for freshness stamp (generation metadata block) → BLOCKING
  6. Check mechanism anchor density (regex for "does X by Y" + citation) → WARNING
  7. Check analogy presence (≥1 per ## section) → WARNING

Output:
{
  "document": "capability-brief.md",
  "type": "capability-brief",
  "overall": "PASS" | "FAIL",
  "gates": [
    {"name": "banned_terms", "status": "PASS", "blocking": true},
    {"name": "provenance", "status": "PASS", "blocking": true},
    {"name": "citations", "status": "FAIL", "blocking": true, "failures": [...]},
    ...
  ],
  "blocking_failures": 1,
  "warnings": 0
}

Exit codes:
  0 — All blocking gates pass (warnings allowed)
  1 — One or more blocking gates failed
```

#### 3.3.5 `inventory-modules.sh`

```
Usage: inventory-modules.sh [--root <path>] [--json]

Enumerates src/ modules with test presence and dependency data.

Logic:
  1. List all top-level directories in src/
  2. For each directory, find primary .ts files
  3. For each file:
     a. Count test files: find tests/ -name "*<module>*" -o -name "*<module>*"
     b. Extract imports: grep "^import" <file> | extract module paths
     c. Extract TODO/FIXME: grep -n "TODO\|FIXME" <file>
  4. Cross-reference with features.yaml for status classification
  5. Cross-reference with limitations.yaml for known limitations

Output: JSON array of module inventory entries
```

#### 3.3.6 `extract-limitations.sh`

```
Usage: extract-limitations.sh [--root <path>] [--json]

Extracts TODO/FIXME tags and cross-references with limitations.yaml.

Logic:
  1. grep -rn "TODO\|FIXME\|HACK\|XXX" src/
  2. Parse each match: file, line, tag, text
  3. Merge with limitations.yaml entries
  4. Deduplicate by file+description

Output: JSON array of limitation entries with source attribution
```

#### 3.3.7 `stamp-freshness.sh`

```
Usage: stamp-freshness.sh <markdown-file>

Appends freshness metadata block to the generated document:

---
<!-- ground-truth-metadata
generated: 2026-02-10T08:15:00Z
head_sha: abc123def456
head_date: 2026-02-10T07:30:00Z
generator: ground-truth v1.0.0
document_type: capability-brief
features_registry_sha: def789...
limitations_registry_sha: ghi012...
-->
```

### 3.4 Registry Files

#### 3.4.1 `features.yaml`

Team-curated registry of feature status classifications. The generator reads this file; it never writes to it.

```yaml
# grimoires/loa/ground-truth/features.yaml
# Curated by team. Generator reads, never writes.
# Status values: stable | beta | experimental | planned | deprecated
#
# Canonical join key: `id` (kebab-case, unique across all features)
# `modules` is an array of paths (a feature may span multiple files)
# `category` must match an entry in capability-taxonomy.yaml

features:
  - id: wal-persistence
    name: WAL Persistence
    modules:
      - src/persistence/wal.ts
      - src/persistence/wal-reader.ts
    status: stable
    category: persistence
    description: Append-only JSONL write-ahead log with flock-based exclusive access

  - id: r2-sync
    name: R2 Sync
    modules:
      - src/persistence/r2-sync.ts
    status: stable
    category: persistence
    description: Cloudflare R2 object storage sync every 30s

  - id: multi-model-orchestration
    name: Multi-Model Orchestration
    modules:
      - src/hounfour/ensemble.ts
      - src/hounfour/native-runtime.ts
    status: beta
    category: orchestration
    description: Claude + GPT-5.2 ensemble with native runtime adapters

  # ... one entry per feature
```

**Registry join semantics**:

| Field | Type | Purpose |
|-------|------|---------|
| `id` | string (kebab-case) | Canonical join key — unique, referenced by inventory output and limitations.yaml |
| `modules` | string[] | Array of file paths (supports multi-file features) |
| `category` | string | Must match a `capabilities[].name` in `capability-taxonomy.yaml` (case-insensitive) |

**Behavior for missing registry matches**: When `inventory-modules.sh` discovers a module in `src/` with no matching `features.yaml` entry, it emits `status: "unknown"` and a warning. This is non-blocking — the generator includes the module with an explicit "Status: Not yet classified" note.

**Behavior for multiple matches**: If a source file appears in multiple feature entries' `modules` arrays, the inventory emits all matching feature IDs. The generator lists the file under each feature.

#### 3.4.2 `limitations.yaml`

Team-curated registry for known limitations not encoded in source code.

```yaml
# grimoires/loa/ground-truth/limitations.yaml
# Limitations not captured by TODO/FIXME tags in source.

limitations:
  - feature_id: wal-persistence        # Join key → features.yaml `id`
    description: Single-writer only; no concurrent sessions per WAL file
    reason: Design choice — compound learning requires consistent state
    decision_ref: grimoires/loa/decisions.yaml

  - feature_id: r2-sync                # Join key → features.yaml `id`
    description: S3 compatibility untested with non-Cloudflare providers
    reason: Only Cloudflare R2 used in production
    issue_ref: null

  # ... one entry per known limitation
  # feature_id MUST match an `id` in features.yaml.
  # If feature_id is not found in features.yaml, inventory-modules.sh emits a WARNING (non-blocking).
```

#### 3.4.3 `capability-taxonomy.yaml`

Curated list of top-level capability categories. Used by the Capability Brief generator to ensure 100% coverage.

```yaml
# grimoires/loa/ground-truth/capability-taxonomy.yaml
# Top-level capabilities that MUST appear in every Capability Brief.

capabilities:
  - name: Persistence
    description: State durability across crashes, restarts, and deployments
    modules: [src/persistence/]

  - name: Orchestration
    description: Multi-model AI agent session management
    modules: [src/agent/, src/hounfour/]

  - name: Review
    description: Autonomous code review with BridgeBuilder persona
    modules: [src/bridgebuilder/]

  - name: Learning
    description: Compound learning cycle — discover, apply, verify
    modules: [src/learning/]

  - name: Scheduling
    description: Background job execution with circuit breakers
    modules: [src/scheduler/, src/cron/]

  - name: Identity
    description: Loa persona injection from BEAUVOIR.md
    modules: [src/agent/]

  - name: Gateway
    description: HTTP/WebSocket server for web access
    modules: [src/gateway/]
```

#### 3.4.4 `banned-terms.txt`

```
blazing
revolutionary
enterprise-grade
cutting-edge
world-class
game-changing
next-generation
best-in-class
state-of-the-art
unparalleled
groundbreaking
paradigm-shifting
disruptive
industry-leading
mission-critical
```

### 3.5 Document Templates

Each template defines the structural requirements for its document type. Templates are NOT fill-in-the-blank forms — they specify required sections, provenance expectations per section, and quality criteria.

#### 3.5.1 Capability Brief Template (Example)

```markdown
# {Project Name}: What It Does

<!-- ground-truth: capability-brief -->
<!-- generated: {timestamp} | head: {sha} -->

## Overview

<!-- provenance: REPO-DOC-GROUNDED -->
{1-3 paragraphs summarizing the system from the PRD. Cite grimoires/loa/prd.md}

## Capabilities

{For EACH entry in capability-taxonomy.yaml, generate a section:}

### {Capability Name}

<!-- provenance: CODE-FACTUAL -->
**What it does**: {Mechanism description. "Does X by Y" pattern. Cite file:line.}

**Code**: {Primary file(s) with line ranges. Format: `path:NN-MM` — description}

<!-- provenance: ANALOGY -->
**Industry parallel**: {BridgeBuilder FAANG/bluechip analogy. Optional per section.
Only include if the parallel is genuine and illuminating. Verify accuracy.}

<!-- provenance: CODE-FACTUAL -->
**Use case**: {Concrete scenario where this capability matters. Ground in evidence.}

## Limitations

<!-- provenance: CODE-FACTUAL -->
{From limitations.yaml + TODO/FIXME extraction. Cite each.}

### Where We're Not a Fit (Today)
{Honest assessment of what the system cannot do.}

---
{Freshness metadata block — auto-stamped by stamp-freshness.sh}
```

### 3.6 BridgeBuilder Voice Template

The voice template is loaded as additional context during the GENERATE phase. It does NOT override the generation prompt — it supplements it with persona guidelines.

```markdown
# BridgeBuilder Voice Guidelines for GTM Documents

## Identity

You write with the voice of a reviewer in the top 0.005% — someone whose code
runs on billions of devices, whose documentation is legendary not for being
flashy but for being *precise and generous simultaneously*.

## Rules

1. **Mechanism over adjective**: Never say "fast" — say "processes 1000 WAL entries
   in <50ms by using append-only writes with flock-based exclusive access"
2. **Industry parallels**: Reference FAANG/bluechip projects ONLY when the parallel
   is structurally genuine. Verify the referenced event actually happened as described.
3. **Metaphors for laypeople**: Complex concepts get accessible parallels. But metaphors
   must illuminate, not obscure.
4. **Frequency**: At least 1 parallel per ## section. Optional per subsection.
   PREFER NO ANALOGY over a forced or inaccurate one.
5. **Honesty**: State limitations as clearly as strengths. "Where We're Not a Fit"
   sections are mandatory and must be substantive.
6. **Citations**: Every CODE-FACTUAL claim cites `file:line`. No exceptions.
7. **70/30 rule**: ~70% mechanism description, ~30% analogy/metaphor/context.
```

---

## 4. Data Flow

### 4.1 Generation Pipeline (7 Stages)

```
Stage 1: GROUND
┌──────────────────────────────────────────────┐
│ Check /ride reality freshness                 │
│ If stale (>7 days): prompt user to re-ride    │
│ If fresh: load grimoires/loa/reality/ files   │
│                                               │
│ Also load:                                    │
│ - grimoires/loa/ground-truth/features.yaml    │
│ - grimoires/loa/ground-truth/limitations.yaml │
│ - grimoires/loa/ground-truth/capability-taxonomy.yaml │
│ - grimoires/loa/decisions.yaml                │
│ - grimoires/loa/NOTES.md                      │
└───────────────────────┬──────────────────────┘
                        ▼
Stage 2: INVENTORY
┌──────────────────────────────────────────────┐
│ Run: inventory-modules.sh --json             │
│ Run: extract-limitations.sh --json           │
│                                               │
│ Output: module inventory + limitation map     │
│ Store as structured context for generation    │
└───────────────────────┬──────────────────────┘
                        ▼
Stage 3: GENERATE
┌──────────────────────────────────────────────┐
│ Load document template from resources/        │
│ Load BridgeBuilder voice template             │
│ Load analogy bank (if analogies requested)    │
│ Load cross-domain references (if research)    │
│                                               │
│ LLM generates document with:                  │
│ - Template structure as scaffold              │
│ - /ride reality as primary evidence           │
│ - Module inventory for file:line citations    │
│ - Voice template for tone/style               │
│ - Provenance tags on every paragraph          │
│                                               │
│ Output: draft markdown to /tmp/               │
└───────────────────────┬──────────────────────┘
                        ▼
Stage 4: VERIFY (deterministic, no LLM)
┌──────────────────────────────────────────────┐
│ Run: quality-gates.sh <draft> --type <type>  │
│                                               │
│ If PASS → Stage 6 (OUTPUT)                   │
│ If FAIL → Stage 5 (REPAIR)                   │
└───────────────────────┬──────────────────────┘
                        ▼
Stage 5: REPAIR (LLM-driven, max 3 iterations)
┌──────────────────────────────────────────────┐
│ Parse quality-gates.sh JSON output            │
│ For each blocking failure:                    │
│   - Read the cited file + line range          │
│   - Correct the citation / remove banned term │
│   - Re-tag provenance if needed               │
│                                               │
│ Output: repaired draft                        │
│ → Return to Stage 4 (VERIFY)                 │
│                                               │
│ After 3 failures: HALT with error report      │
│ "Unable to produce verified document after    │
│  3 repair iterations. Manual review needed."  │
└──────────────────────────────────────────────┘

Stage 6: OUTPUT
┌──────────────────────────────────────────────┐
│ Run: stamp-freshness.sh <verified-draft>     │
│ Write to grimoires/loa/ground-truth/<name>.md │
│ Update generation-manifest.json               │
│ Log to trajectory:                            │
│   grimoires/loa/a2a/trajectory/ground-truth-*.jsonl │
└──────────────────────────────────────────────┘
```

### 4.2 Document Type Dispatch

The skill accepts `--<type>` flags that select which document to generate. Each type loads its specific template and may require different context:

| Type Flag | Template | Required Context | Phase |
|-----------|----------|-----------------|-------|
| `--capability-brief` | `capability-brief.md` | /ride reality + capability-taxonomy.yaml + features.yaml | MVP |
| `--architecture-overview` | `architecture-overview.md` | /ride reality + decisions.yaml + SDD | MVP |
| `--feature-inventory` | `feature-inventory.md` | inventory-modules.sh output + features.yaml + limitations.yaml | Phase 2 |
| `--thinking-in-loa` | `thinking-in-loa.md` | PRD + SDD + NOTES.md | Phase 2 |
| `--tradeoffs` | `tradeoffs.md` | features.yaml + limitations.yaml + decisions.yaml | Phase 2 |
| `--release-narrative <ver>` | `release-narrative.md` | CHANGELOG.md + git log for version | Phase 2 |
| `--research-brief` | `research-brief.md` | Issue #247 content + cross-domain refs | Phase 3 |
| (no flag) | All MVP types sequentially | All context | — |

### 4.3 Context Loading Strategy

The generation prompt is assembled from multiple sources organized into two tiers:

**Tier A — Hard constraints (non-negotiable output schema):**
These are loaded first and framed as strict requirements the output MUST satisfy.

```
Constraint 1: Document template (required sections, provenance expectations, evidence anchor format)
Constraint 2: Quality gate requirements (banned terms, honesty section, freshness stamp)
Constraint 3: Provenance tagging rules (every taggable paragraph must be classified)
```

**Tier B — Evidence and enrichment (prioritized by trustworthiness):**
These provide the content; constraints from Tier A govern the structure.

```
Priority 1 (highest): /ride reality files (CODE IS TRUTH)
Priority 2: Registry files (features.yaml, limitations.yaml)
Priority 3: Shell script output (inventory-modules.sh, extract-limitations.sh)
Priority 4: Grimoire state (decisions.yaml, NOTES.md)
Priority 5: BridgeBuilder voice template
Priority 6 (lowest): Analogy bank + cross-domain references
```

**Rationale**: Templates are hard constraints, not low-priority context. If the generator ignores template structure, it will fail quality gates (missing Limitations section, missing provenance tags), pushing work into the repair loop unnecessarily. By loading constraints first, we maximize the chance of first-pass verification success.

**Token budget**: The generation prompt will be large. Context management strategy:

| Source | Estimated Tokens | Loading Strategy |
|--------|-----------------|-----------------|
| /ride reality | 8,000-15,000 | Load relevant sections only (per doc type) |
| Registry files | 500-1,500 | Load in full |
| Shell script output | 1,000-3,000 | Load in full (JSON) |
| Grimoire state | 2,000-5,000 | Load summary sections only |
| Voice template | 500 | Load in full |
| Analogy bank | 1,000-2,000 | Load relevant category only |
| Document template | 500-1,000 | Load in full |
| **Total estimate** | **13,500-28,000** | — |

If total exceeds 30,000 tokens, apply progressive disclosure:
1. Trim analogy bank to top 5 per capability
2. Trim /ride reality to module-level summaries
3. Trim grimoire state to decisions only

---

## 5. Verification Architecture

### 5.1 Design Principle: Separation of Generation and Verification

The verification layer MUST have zero LLM involvement. This is the architectural firewall that prevents the system from "approving its own work."

```
LLM boundary
────────────────────────────────────────────
GENERATE (Stage 3)     │  VERIFY (Stage 4)
  - Reads context      │  - Shell scripts only
  - Produces markdown   │  - Regex + git + sed
  - Tags provenance     │  - Deterministic
  - Cites file:line     │  - No API calls
────────────────────────────────────────────
REPAIR (Stage 5)       │
  - Reads failures     │
  - Fixes citations    │
  - Re-tags provenance │
────────────────────────────────────────────
```

### 5.2 Verification Flow

```
quality-gates.sh (orchestrator)
├── scan-banned-terms.sh ──→ BLOCKING (exit 1 → overall FAIL)
├── check-provenance.sh ──→ BLOCKING (exit 1 → overall FAIL)
├── verify-citations.sh ──→ BLOCKING (exit 1 → overall FAIL)
├── section-check ─────────→ BLOCKING (grep for "Limitations" heading)
├── freshness-check ───────→ BLOCKING (grep for ground-truth-metadata)
├── mechanism-anchor ──────→ WARNING  (regex for "does X by Y" pattern)
└── analogy-presence ──────→ WARNING  (count ## sections with ANALOGY tags)
```

### 5.3 Repair Loop

When verification fails, the LLM receives structured failure data:

```json
{
  "iteration": 1,
  "max_iterations": 3,
  "failures": [
    {
      "gate": "citations",
      "citation": "src/persistence/wal.ts:47-89",
      "check": "EVIDENCE_ANCHOR",
      "anchor": "symbol=flock",
      "actual_content": "export async function writeEntry(entry: WALEntry) {",
      "paragraph": "WAL writes use flock-based exclusive access"
    }
  ],
  "instructions": "Fix each failed citation by reading the actual file and finding the correct line range. Do NOT change the claim — change the citation to match reality."
}
```

**Repair rules**:
1. Fix the citation, not the claim (the claim should be grounded in reality)
2. If the claim itself is wrong (the code doesn't do what was claimed), update both
3. If a claim cannot be grounded, convert it from CODE-FACTUAL to HYPOTHESIS with an epistemic marker
4. Never fabricate a citation to make the verifier pass

---

## 6. Integration Points

### 6.1 `/ride` Integration

Ground Truth depends on `/ride` output as its primary evidence source. The integration is read-only — Ground Truth never modifies `/ride` output.

| /ride Output | Ground Truth Usage |
|-------------|-------------------|
| `grimoires/loa/reality/` | Module inventory, route maps, entity models |
| `/ride` grounding markers `[GROUNDED]`, `[INFERRED]` | Mapped to Ground Truth provenance classes |
| `/ride` `file:line` citations | Reused directly when accurate; verified independently |

**Freshness check**: Before generation, check `/ride` output age:
```bash
ride_date=$(stat -c %Y grimoires/loa/reality/README.md 2>/dev/null || echo 0)
now=$(date +%s)
age_days=$(( (now - ride_date) / 86400 ))
if [ $age_days -gt 7 ]; then
  echo "WARNING: /ride output is $age_days days old. Consider re-running /ride."
fi
```

### 6.2 BridgeBuilder Integration

Ground Truth uses the BridgeBuilder persona for voice/tone but does NOT invoke the BridgeBuilder review pipeline. The integration is one-way: Ground Truth loads BridgeBuilder voice guidelines as context.

| BridgeBuilder Component | Ground Truth Usage |
|------------------------|-------------------|
| Persona definition (#24) | Extracted into `resources/voice/bridgebuilder-gtm.md` |
| FAANG analogy principles | Applied via voice template during GENERATE |
| Review pipeline (`src/bridgebuilder/`) | NOT used — Ground Truth generates docs, not PR reviews |

### 6.3 Flatline Protocol Integration (Phase 2)

> **Scope**: Flatline integration is **out of scope for v1.0.0**. The baseline deterministic verifier is the sole quality gate in Sprint 1-2. Flatline integration is planned for Phase 2 after the core pipeline is proven stable.

**Rationale**: The deterministic shell-script verifier already enforces factual correctness via evidence anchors, provenance tags, and banned-term scanning. Adding Flatline before the baseline pipeline is battle-tested would conflate verification failures (pipeline bugs) with adversarial review findings (quality improvements).

**Phase 2 Stub Interface** (for future implementation):

```bash
# .claude/scripts/ground-truth/flatline-ground-truth.sh
# Status: STUB — returns SKIPPED until Phase 2 implementation
#
# Input:  $1 = path to generated document
# Output: JSON to stdout
# Exit:   0 = SKIPPED/PASS, 1 = CHANGES_REQUIRED
#
# Expected output format:
# { "status": "SKIPPED", "reason": "Flatline integration not yet implemented (Phase 2)" }

set -euo pipefail
echo '{"status":"SKIPPED","reason":"Flatline integration not yet implemented (Phase 2)"}'
exit 0
```

**Phase 2 integration point** in `quality-gates.sh`:

```bash
# After all blocking gates pass:
if [[ "${GROUND_TRUTH_FLATLINE:-false}" == "true" ]]; then
  flatline_result=$(.claude/scripts/ground-truth/flatline-ground-truth.sh "$doc_path")
  flatline_status=$(echo "$flatline_result" | jq -r '.status')
  if [[ "$flatline_status" == "SKIPPED" ]]; then
    echo "INFO: Flatline integration not available (Phase 2)" >&2
  fi
fi
```

**Phase 2 configuration** (not read by v1.0.0):
```yaml
# .loa.config.yaml — ignored until Phase 2
ground_truth:
  flatline:
    enabled: false             # Phase 2: set true when implemented
    auto_trigger: false
    phases:
      capability_brief: true
      architecture_overview: true
      feature_inventory: false
```

### 6.4 Beads Integration

Document generation is tracked as beads tasks when beads_rust is available:

```bash
# Before generation
br create --label "ground-truth:capability-brief" --tag "gtm"

# On successful output
br close --id <bead-id> --note "Generated, verified, 24 citations checked"

# On failure (max repair iterations)
br update --id <bead-id> --status blocked --note "3 repair iterations failed"
```

---

## 7. Output Format

### 7.1 Document Structure

Every generated document follows this structure:

```markdown
# {Document Title}

<!-- ground-truth: {document-type} -->
<!-- generated: {ISO8601} | head: {short-sha} | generator: ground-truth v{version} -->

{Document content with provenance tags...}

---

## Generation Metadata

| Field | Value |
|-------|-------|
| Generated | {ISO8601 timestamp} |
| HEAD SHA | {full SHA} |
| HEAD date | {commit date} |
| Generator | ground-truth v{version} |
| Document type | {type} |
| Quality gates | {PASS with N citations verified, M warnings} |
| Features registry | {SHA of features.yaml at generation time} |
| Limitations registry | {SHA of limitations.yaml at generation time} |

<!-- ground-truth-metadata
generated: {ISO8601}
head_sha: {full-sha}
head_date: {commit-date}
generator: ground-truth v1.0.0
document_type: {type}
quality_gates: PASS
citations_verified: {N}
warnings: {M}
features_registry_sha: {sha}
limitations_registry_sha: {sha}
-->
```

### 7.2 `generation-manifest.json`

Tracks all generated documents with checksums:

```json
{
  "version": "1.0.0",
  "last_generated": "2026-02-10T08:15:00Z",
  "head_sha": "abc123def456",
  "documents": {
    "capability-brief": {
      "path": "grimoires/loa/ground-truth/capability-brief.md",
      "generated": "2026-02-10T08:15:00Z",
      "checksum": "sha256:...",
      "citations_verified": 24,
      "quality_gates": "PASS",
      "warnings": 1
    },
    "architecture-overview": {
      "path": "grimoires/loa/ground-truth/architecture-overview.md",
      "generated": "2026-02-10T08:20:00Z",
      "checksum": "sha256:...",
      "citations_verified": 31,
      "quality_gates": "PASS",
      "warnings": 0
    }
  }
}
```

---

## 8. Error Handling & Recovery

### 8.1 Failure Modes

| Failure | Stage | Recovery |
|---------|-------|----------|
| `/ride` output missing | GROUND | Prompt user to run `/ride` first |
| `/ride` output stale (>7 days) | GROUND | Warn user; proceed with stale data or re-ride |
| `features.yaml` missing | GROUND | **Fail fast** with clear error and bootstrap command (see §8.3) |
| Shell script not found | INVENTORY | Halt with install instructions |
| yq not installed | INVENTORY | Halt with `brew install yq` / `apt install yq` |
| LLM generation fails | GENERATE | Retry once; on second failure, save partial output and halt |
| Verification fails (blocking gate) | VERIFY | Enter REPAIR loop (max 3 iterations) |
| Repair loop exhausted (3 iterations) | REPAIR | Halt with detailed failure report; save last draft for manual review |
| Flatline API timeout | optional FLATLINE | Skip Flatline; proceed to OUTPUT (Flatline is optional) |

### 8.2 Circuit Breaker

If the same document type fails verification 3 times in a row across separate invocations, log a warning to `grimoires/loa/NOTES.md`:

```markdown
## Blockers

- [2026-02-10] ground-truth: capability-brief failed verification 3 consecutive times.
  Last failure: EVIDENCE_ANCHOR (symbol=flock) on src/persistence/wal.ts:47-89.
  Likely cause: /ride reality is stale or features.yaml is out of date.
  Action: Re-run /ride and review features.yaml.
```

### 8.3 Registry Bootstrap

Registries (`features.yaml`, `limitations.yaml`, `capability-taxonomy.yaml`) are **team-curated inputs** — the generator never writes to them. When registries are missing, the pipeline fails fast with actionable instructions rather than auto-generating files that violate the curation policy.

**Bootstrap command** (provided in error message):

```bash
# .claude/scripts/ground-truth/bootstrap-registries.sh
# Creates starter registry files with TODO placeholders for team curation.
# These files MUST be reviewed and committed by a human before /ground-truth will run.
#
# Usage: .claude/scripts/ground-truth/bootstrap-registries.sh [--dir <path>]
# Default dir: grimoires/loa/ground-truth/
#
# Exit codes:
#   0 = files created successfully
#   1 = files already exist (no overwrite)
#   2 = target directory not found

set -euo pipefail
TARGET_DIR="${1:-grimoires/loa/ground-truth}"

if [[ ! -d "$TARGET_DIR" ]]; then
  echo "ERROR: Directory $TARGET_DIR does not exist" >&2
  exit 2
fi

for file in features.yaml limitations.yaml capability-taxonomy.yaml; do
  if [[ -f "$TARGET_DIR/$file" ]]; then
    echo "SKIP: $TARGET_DIR/$file already exists" >&2
    exit 1
  fi
done

# Create features.yaml starter
cat > "$TARGET_DIR/features.yaml" << 'FEATEOF'
# Ground Truth Feature Registry — TEAM-CURATED
# Run: inventory-modules.sh --list-modules to see discovered modules.
# Add entries here to map modules to named features.
# Required fields: id (kebab-case, unique), name, status, category, modules[]

features:
  - id: example-feature           # TODO: Replace with real feature
    name: Example Feature
    status: stable                # stable | experimental | deprecated | planned
    category: example-category    # Must match capability-taxonomy.yaml
    modules:
      - src/example/index.ts      # Paths relative to repo root
FEATEOF

# Create limitations.yaml starter
cat > "$TARGET_DIR/limitations.yaml" << 'LIMEOF'
# Ground Truth Limitations Registry — TEAM-CURATED
# Known limitations not captured by TODO/FIXME tags in source code.
# feature_id must match an `id` in features.yaml.

limitations:
  - feature_id: example-feature   # TODO: Replace with real limitation
    description: Example limitation description
    reason: Example reason
    decision_ref: null
LIMEOF

# Create capability-taxonomy.yaml starter
cat > "$TARGET_DIR/capability-taxonomy.yaml" << 'TAXEOF'
# Ground Truth Capability Taxonomy — TEAM-CURATED
# Top-level capability categories for the Capability Brief.
# Every feature in features.yaml must map to one of these categories.

capabilities:
  - id: example-category          # TODO: Replace with real categories
    name: Example Category
    description: Example category description
TAXEOF

echo "SUCCESS: Starter registries created in $TARGET_DIR/"
echo "ACTION REQUIRED: Edit these files to reflect your project, then commit."
```

**Fail-fast error message** (emitted by `quality-gates.sh` or SKILL.md preflight):

```
ERROR: Required registry file missing: grimoires/loa/ground-truth/features.yaml

Ground Truth requires team-curated registry files before generation.
These files define which features exist and their status — the generator
never creates or modifies them.

To create starter files:
  .claude/scripts/ground-truth/bootstrap-registries.sh

Then edit the files to reflect your project and commit them.
See: grimoires/loa/sdd-ground-truth.md §3.4 for registry format.
```

---

## 9. Security Considerations

### 9.1 Scope Constraints

| Constraint | Rationale |
|-----------|-----------|
| `app: read-only` | Ground Truth reads `src/` but never modifies application code |
| Shell scripts scoped to `.claude/scripts/ground-truth/` | No arbitrary bash execution |
| No external API calls | No data leaves the machine (except optional Flatline) |
| No secrets in output | Verification scripts do not process env vars or .env files |
| Registry files in grimoires/ (state zone) | Team-editable but version-controlled |

### 9.2 Output Safety

- Generated documents are markdown only — no executable code blocks that could be run
- Citation patterns are validated against git-tracked files only (no system path traversal)
- Provenance tags are HTML comments (not rendered by most markdown viewers)

---

## 10. Sprint Mapping

### Sprint 1: Infrastructure + Capability Brief Draft

| Task | Component | Effort |
|------|-----------|--------|
| Create `features.yaml` with initial feature inventory | Registry | Low — manual curation from existing knowledge |
| Create `limitations.yaml` from TODO/FIXME extraction | Registry | Low — automated extraction + manual review |
| Create `capability-taxonomy.yaml` | Registry | Low — 7 top-level categories already known |
| Create `banned-terms.txt` | Registry | Trivial — list from PRD §2 |
| Implement `verify-citations.sh` | Script | Medium — regex extraction + git ls-files + sed line check |
| Implement `scan-banned-terms.sh` | Script | Low — grep with context-aware skipping |
| Implement `check-provenance.sh` | Script | Medium — paragraph detection + tag validation |
| Implement `quality-gates.sh` orchestrator | Script | Low — calls other scripts, aggregates JSON |
| Implement `inventory-modules.sh` | Script | Medium — directory traversal + import parsing |
| Implement `extract-limitations.sh` | Script | Low — grep + YAML merge |
| Implement `stamp-freshness.sh` | Script | Trivial — git rev-parse + date + sed append |
| Create Capability Brief template | Resource | Low — structural scaffold from PRD §4.2.1 |
| Create BridgeBuilder voice template | Resource | Low — extract from #24 spec |
| Write SKILL.md with workflow phases | Skill | Medium — 7-stage pipeline with repair loop |
| Generate first Capability Brief | Test | Medium — end-to-end pipeline test |

### Sprint 2: Verification Loop + Architecture Overview

| Task | Component | Effort |
|------|-----------|--------|
| Prove verify → repair → re-verify loop | Integration | Medium — iterative testing |
| Create Architecture Overview template | Resource | Low — structural scaffold from PRD §4.2.2 |
| Generate Architecture Overview | Test | Medium — second doc type through full pipeline |
| Wire quality gates into SKILL.md workflow | Integration | Low — already designed, just wiring |
| Create generation-manifest.json writer | Script | Low — jq-based JSON assembly |
| Add beads integration (optional) | Integration | Low — br create/close commands |
| End-to-end test: /ground-truth with both doc types | Test | Medium — full pipeline validation |

---

## 11. Design Decisions Log

| Decision | Options Considered | Choice | Rationale |
|----------|-------------------|--------|-----------|
| Verification: shell vs LLM | Shell scripts / LLM inline / Hybrid | Shell scripts | Deterministic; no LLM variability; independently testable; prevents "hallucinated verification" |
| Skill type: single composite vs multiple | Single `/ground-truth` / Multiple (`/capability-brief`, `/arch-overview`, etc.) | Single composite with type flags | Shared infrastructure (verifier, voice, registries); simpler to maintain; follows `/ride` pattern |
| Output location | `grimoires/loa/ground-truth/` / `docs/` / root-level | `grimoires/loa/ground-truth/` | State zone (writeable); version-controlled; co-located with other grimoire artifacts |
| Registry format | YAML / JSON / TOML | YAML | Human-editable; consistent with `.loa.config.yaml`; parseable by yq |
| Repair strategy | Fix citation / Fix claim / Drop claim | Fix citation first; fix claim if citation is correct and claim is wrong; convert to HYPOTHESIS if ungroundable | Preserves factual accuracy while allowing graceful degradation |
| Context loading | Load everything / Progressive disclosure | Progressive with token budget | Prevents context window exhaustion; prioritizes code reality over enrichment |
| Template approach | Fill-in-the-blank / Structural scaffold | Structural scaffold | Templates define required sections and provenance expectations, not exact wording; allows natural voice |

---

## Next Step

After SDD approval: `/sprint-plan` to break down Sprint 1-2 into implementation tasks.
