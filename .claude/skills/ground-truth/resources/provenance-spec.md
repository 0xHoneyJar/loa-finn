# Provenance Specification — Ground Truth v1.0.0

> Shared contract between the generator (SKILL.md) and the verifier (check-provenance.sh).
> Both MUST reference this file as their source of truth for tag syntax and citation rules.

## Provenance Tag Syntax

Every taggable paragraph MUST be preceded by an HTML comment tag:

```
<!-- provenance: CLASS -->
```

Where CLASS is one of the following 7 provenance classes:

| Class | Definition |
|-------|-----------|
| `CODE-FACTUAL` | A claim about what the codebase does or contains |
| `DERIVED` | A claim verifiable by aggregation or computation across multiple code locations |
| `REPO-DOC-GROUNDED` | A claim derived from project documentation (PRD, SDD, decisions.yaml) |
| `ISSUE-GROUNDED` | A claim derived from GitHub issue discussions |
| `ANALOGY` | A FAANG/bluechip parallel or metaphor |
| `HYPOTHESIS` | A research-stage claim about theoretical foundations |
| `EXTERNAL-REFERENCE` | A factual assertion about something outside this project |

## Citation Rules Per Class

### CODE-FACTUAL
- MUST contain at least one backtick-wrapped `file:line` citation
- Citation format: `` `path/to/file.ext:NN` `` or `` `path/to/file.ext:NN-MM` ``
- Path must be repo-relative, matching `^[a-zA-Z0-9_./-]+$`
- MUST include an evidence anchor comment (see below)

### DERIVED
- MUST contain at least one of:
  - **Multiple citations**: Two or more backtick-wrapped `file:line` references
  - **Script reference**: A backtick reference to a computation script (e.g., `provenance-stats.sh`, `extract-doc-deps.sh`, `generation-manifest.json`)
- Use for aggregated/computed claims: module counts, layer counts, task enumerations, configuration summaries
- DERIVED counts equivalent to CODE-FACTUAL for trust_level computation (see ADR-002)
- Example:
  ```markdown
  <!-- provenance: DERIVED -->
  The system has 8 modules across 5 layers (`src/index.ts:15`, `docs/architecture.md:23`).
  ```

### REPO-DOC-GROUNDED
- MUST cite source document and section
- Format: `grimoires/loa/prd.md §3.2` or similar

### ISSUE-GROUNDED
- MUST cite issue number and optionally comment
- Format: `#48` or `loa-finn#24 comment 3`

### ANALOGY
- NO code citation required
- Must be factually accurate about the referenced project
- Must not be forced — prefer no analogy over a bad one

### HYPOTHESIS
- Paragraph MUST begin with an epistemic marker phrase:
  - "We hypothesize"
  - "We are exploring"
  - "We believe"
  - "Early evidence suggests"
  - "It is plausible that"
- MUST cite source (issue, paper, or reasoning)

### EXTERNAL-REFERENCE
- MUST contain a URL (`https://...`) OR a paper/book reference in parentheses
- Example: `(Ostrom, 1990)` or `https://kubernetes.io/docs/concepts/`

## Evidence Anchor Syntax

For CODE-FACTUAL paragraphs, the generator MUST emit an evidence anchor:

```html
<!-- evidence: symbol=functionName, symbol=className, literal="exact string" -->
```

Rules:
- `symbol=X` — the identifier X must appear in the cited line range
- `literal="Y"` — the exact string Y must appear in the cited line range
- Multiple tokens separated by `, `
- The verifier checks ALL tokens against the extracted lines
- ALL tokens must match for the check to pass

## Paragraph Detection

A "taggable paragraph" is defined as:
- One or more consecutive non-empty lines in NORMAL state
- Separated from other paragraphs by one or more blank lines

The following are NOT taggable (excluded by the awk state machine):
- YAML frontmatter (between `---` delimiters at start of file)
- Fenced code blocks (between `` ``` `` or `~~~` delimiters)
- HTML comments (between `<!--` and `-->`)
- Blockquote lines (starting with `> `)
- Table rows (starting with `|`)
- Heading lines (starting with `#`)
- List items (starting with `- `, `* `, `1. `) — these are part of their parent paragraph's provenance

## INFERRED Subclassification (Optional)

The INFERRED class supports optional parenthetical qualifiers to distinguish between trust profiles:

```
<!-- provenance: INFERRED (architectural) -->
<!-- provenance: INFERRED (upgradeable) -->
```

| Qualifier | Meaning |
|-----------|---------|
| `(architectural)` | Inherently inferential — architectural properties, design rationale, cross-module behavior that cannot be reduced to code citations |
| `(upgradeable)` | Lazily unverified — could potentially be upgraded to CODE-FACTUAL or DERIVED with additional citation work |

**Rules**:
- Qualifiers are optional — unqualified `INFERRED` remains valid
- All quality gates accept both qualified and unqualified forms
- `provenance-stats.sh` counts both as INFERRED for trust_level computation
- Qualifiers are informational for human reviewers and future tooling

## Tag Coverage Threshold

- Minimum 95% of taggable paragraphs must have a provenance tag
- The remaining 5% allows for transitional sentences, section introductions, etc.
