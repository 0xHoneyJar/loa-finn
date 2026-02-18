#!/usr/bin/env bash
# lint-git-deps.sh — Reject mutable git tag references in package.json
#
# Per SKP-006: All github: dependencies MUST use immutable 40-char commit SHAs.
# Mutable tags (#v...) can be force-pushed, breaking reproducible builds.
#
# Usage: scripts/lint-git-deps.sh
# Exit 0 = pass, Exit 1 = mutable tag found

set -euo pipefail

PACKAGE_JSON="${1:-package.json}"

# Match github: dependencies using mutable tag refs (#v...)
# Valid: github:Org/Repo#abc123def456... (40 hex chars)
# Invalid: github:Org/Repo#v7.0.0
if grep -qE '"github:[^"]*#v[^"]*"' "$PACKAGE_JSON"; then
  echo "ERROR: Mutable git tag reference found in $PACKAGE_JSON"
  echo ""
  grep -nE '"github:[^"]*#v[^"]*"' "$PACKAGE_JSON"
  echo ""
  echo "Fix: Replace #v<tag> with the resolved commit SHA:"
  echo "  git ls-remote <repo-url> refs/tags/<tag>"
  echo ""
  echo "See: SKP-006 — Immutable SHA pinning"
  exit 1
fi

# Also reject short SHAs (< 40 hex chars after #)
# Extract all github: refs and verify each is exactly 40 hex chars
while IFS= read -r line; do
  ref=$(echo "$line" | sed -n 's/.*github:[^"]*#\([^"]*\)".*/\1/p')
  if [ -n "$ref" ] && ! echo "$ref" | grep -qE '^[0-9a-f]{40}$'; then
    echo "WARNING: Non-SHA ref '$ref' in $PACKAGE_JSON (must be full 40-char hex SHA)"
    echo "$line"
    exit 1
  fi
done < <(grep -E '"github:' "$PACKAGE_JSON" 2>/dev/null || true)

echo "OK: All github: dependencies use immutable commit SHAs"
exit 0
