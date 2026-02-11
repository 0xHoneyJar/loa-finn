# paragraph-detector.awk — Shared paragraph detection state machine
# Used by check-provenance.sh and provenance-stats.sh for consistent paragraph boundary detection.
#
# Interface contract:
#   - Consumers MUST define: process_paragraph(start, tag_class)
#   - Consumers MUST define: END block
#   - This file provides: state machine, pending_tag_class, in_paragraph, para_start,
#     para_end, current_section, para_first_line, total_paragraphs, tagged_paragraphs,
#     pending_tag_qualifier
#   - State transitions: NORMAL, IN_FRONTMATTER, IN_FENCE, IN_HTML_COMMENT
#
# Usage (multi-file composition):
#   awk -f shared/paragraph-detector.awk -f check-provenance-logic.awk "$DOC_PATH"

BEGIN {
  state = "NORMAL"
  fm_count = 0
  in_paragraph = 0
  para_start = 0
  para_end = 0
  pending_tag_class = ""
  pending_tag_qualifier = ""
  para_first_line = ""
  current_section = ""
  total_paragraphs = 0
  tagged_paragraphs = 0
}

# reset_paragraph_state — Flush current paragraph and zero all state variables.
# Extracted helper prevents forgetting to reset a new variable (e.g., pending_tag_confidence)
# when one is added in the future. Ref: BridgeBuilder F1 — "K&R created clearerr() for the same reason"
function reset_paragraph_state() {
  process_paragraph(para_start, pending_tag_class)
  in_paragraph = 0
  pending_tag_class = ""
  pending_tag_qualifier = ""
}

{
  # ── State transitions ──

  # Frontmatter
  if (state == "NORMAL" && /^---[[:space:]]*$/ && (NR <= 1 || fm_count == 0)) {
    if (in_paragraph) reset_paragraph_state()
    state = "IN_FRONTMATTER"; fm_count++; next
  }
  if (state == "IN_FRONTMATTER") { if (/^---[[:space:]]*$/) state = "NORMAL"; next }

  # Fenced code blocks
  if (state == "NORMAL" && /^```/) {
    if (in_paragraph) reset_paragraph_state()
    state = "IN_FENCE"; next
  }
  if (state == "IN_FENCE") { if (/^```/) state = "NORMAL"; next }

  # Multi-line HTML comments
  if (state == "NORMAL" && /<!--/ && !/-->/) {
    # Check for provenance tag (mawk-compatible: no 3-arg match)
    # Accepts optional subclassification: <!-- provenance: INFERRED (architectural) -->
    if (match($0, /<!-- provenance: [A-Z_-]+/)) {
      tmp = substr($0, RSTART, RLENGTH)
      sub(/<!-- provenance: /, "", tmp)
      sub(/ .*/, "", tmp)  # Strip any qualifier after class name
      pending_tag_class = tmp
      # Extract qualifier if present: (architectural), (upgradeable), (pending-evidence)
      # Intentionally permissive — unknown qualifiers are parsed but counted as
      # unqualified in consumers. Strict validation would couple the parser to
      # the qualifier vocabulary. See provenance-spec.md for valid qualifiers.
      pending_tag_qualifier = ""
      if (match($0, /\([a-z-]+\)/)) {
        pending_tag_qualifier = substr($0, RSTART+1, RLENGTH-2)
      }
    }
    state = "IN_HTML_COMMENT"; next
  }
  if (state == "IN_HTML_COMMENT") { if (/-->/) state = "NORMAL"; next }

  # Single-line HTML comments (provenance tags or evidence anchors)
  # Accepts optional subclassification: <!-- provenance: INFERRED (architectural) -->
  if (state == "NORMAL" && /<!--.*-->/) {
    if (match($0, /<!-- provenance: [A-Z_-]+/)) {
      tmp = substr($0, RSTART, RLENGTH)
      sub(/<!-- provenance: /, "", tmp)
      sub(/ .*/, "", tmp)  # Strip any qualifier after class name
      pending_tag_class = tmp
      # Extract qualifier if present: (architectural), (upgradeable), (pending-evidence)
      pending_tag_qualifier = ""
      if (match($0, /\([a-z-]+\)/)) {
        pending_tag_qualifier = substr($0, RSTART+1, RLENGTH-2)
      }
    }
    next
  }

  # Skip non-taggable lines in NORMAL state
  if (state == "NORMAL") {
    # Headings
    if (/^#+[[:space:]]/) {
      if (in_paragraph) reset_paragraph_state()
      current_section = $0
      sub(/^#+[[:space:]]+/, "", current_section)
      next
    }
    # Table rows
    if (/^\|/) {
      if (in_paragraph) reset_paragraph_state()
      next
    }
    # Blockquotes
    if (/^>/) {
      if (in_paragraph) reset_paragraph_state()
      next
    }
    # Blank lines end paragraphs
    if (/^[[:space:]]*$/) {
      if (in_paragraph) reset_paragraph_state()
      next
    }
    # Non-blank, non-control line = paragraph content
    if (!in_paragraph) {
      in_paragraph = 1
      para_start = NR
      para_end = NR
      para_first_line = $0
    } else {
      para_end = NR
    }
  }
}
