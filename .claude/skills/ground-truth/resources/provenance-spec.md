# Provenance Specification — Ground Truth v1.0.0

> Shared contract between the generator (SKILL.md) and the verifier (check-provenance.sh).
> Both MUST reference this file as their source of truth for tag syntax and citation rules.

## Provenance Tag Syntax

Every taggable paragraph MUST be preceded by an HTML comment tag:

```
<!-- provenance: CLASS -->
```

Where CLASS is one of the following 6 provenance classes:

| Class | Definition |
|-------|-----------|
| `CODE-FACTUAL` | A claim about what the codebase does or contains |
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

## Tag Coverage Threshold

- Minimum 95% of taggable paragraphs must have a provenance tag
- The remaining 5% allows for transitional sentences, section introductions, etc.
