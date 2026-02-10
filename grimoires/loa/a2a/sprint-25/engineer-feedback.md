# Sprint 25 (cycle-010 sprint-1) — Engineer Feedback

**Verdict**: CHANGES_REQUIRED
**Reviewer**: Senior Technical Lead
**Date**: 2026-02-10

---

## Blocking Issues (2)

### B1: EVIDENCE_ANCHOR verification not implemented

**AC reference**: Task 1.6 — "EVIDENCE_ANCHOR parses `<!-- evidence: symbol=X, literal="Y" -->` and checks each token against extracted lines"

**Current state**: `verify-citations.sh` lines 127-130 contain a stub comment:
```
# ── Step 5: EVIDENCE_ANCHOR (checked separately per paragraph) ──
# Evidence anchors are validated in check-provenance.sh or quality-gates.sh
# verify-citations.sh only validates file/line accessibility
```

But **no script** actually validates evidence anchors. Neither `check-provenance.sh` nor `quality-gates.sh` parse `<!-- evidence: ... -->` tags or verify tokens against cited lines.

**Required fix**: Implement step 5 in `verify-citations.sh`:
1. For each paragraph with a `<!-- evidence: ... -->` anchor, parse `symbol=X` and `literal="Y"` tokens
2. Check each token against the cited line range (already extracted in step 4)
3. Fail if any token is missing from the extracted lines
4. Add failures to the JSON output with `"check":"EVIDENCE_ANCHOR"`

**Files**: `.claude/scripts/ground-truth/verify-citations.sh`

---

### B2: Missing test fixtures for two failure modes

**AC reference**: Task 1.6 — "Fixture tests: at least 1 valid citation (pass), 1 bad path (exit 3), 1 missing file (exit 1), 1 wrong line range (exit 1), 1 missing anchor token (exit 1)"

**Current state**: 6 fixtures exist but missing:
- `fail-wrong-line-range.md` — a citation pointing to lines that don't exist (e.g., `src/persistence/index.ts:9999`)
- `fail-missing-anchor.md` — a CODE-FACTUAL paragraph with an evidence anchor citing a symbol not present in the cited lines

**Required fix**: Create these two fixture files and add corresponding test assertions in `run-tests.sh`.

**Files**: `tests/ground-truth/fixtures/`, `tests/ground-truth/run-tests.sh`

---

## Non-Blocking Issues (3)

### NB1: `grep -oP` in quality-gates.sh is not POSIX-portable

**File**: `.claude/scripts/ground-truth/quality-gates.sh:136`
```bash
meta_sha=$(echo "$meta_line" | grep -oP 'head_sha=\K[^ ]+' || echo "")
```

`\K` is a Perl regex feature. This will fail on BSD grep or systems without GNU grep `-P` support. Replace with:
```bash
meta_sha=$(echo "$meta_line" | sed 's/.*head_sha=\([^ ]*\).*/\1/' || echo "")
```

### NB2: No false-positive test for banned terms in code blocks

**AC reference**: Task 1.7 — "False positive test: 'enterprise-grade' inside a code block is NOT flagged"

The awk preprocessor correctly strips code blocks, but no fixture verifies this. Consider adding a `pass-banned-in-codeblock.md` fixture with a banned term inside a fenced code block.

### NB3: Feature count discrepancy in reviewer.md

The reviewer.md claims "20 features" but `features.yaml` contains 19 entries. Cosmetic only — the actual count exceeds the AC minimum of 7.

---

## What Passed Review

- All 8 shell scripts exist and are executable
- `set -euo pipefail` consistently applied
- mawk compatibility fixed (no gawk dependency)
- PATH_SAFETY correctly runs before any file I/O
- Registry cross-references are consistent (all feature_ids match, all categories match taxonomy)
- All 12 cited module paths in features.yaml actually exist in the codebase
- Test harness correctly captures exit codes and validates JSON fields
- 19/19 tests pass
- SKILL.md correctly defines the 7-stage pipeline with repair loop contract
- Provenance spec is comprehensive and consistent with check-provenance.sh implementation
- BridgeBuilder voice template properly enforces mechanism-over-adjective philosophy
- Bootstrap script correctly prevents overwrite (exit 1) and handles missing directory (exit 2)
