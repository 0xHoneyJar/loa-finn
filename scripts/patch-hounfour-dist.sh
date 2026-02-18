#!/usr/bin/env bash
# patch-hounfour-dist.sh — Rebuild loa-hounfour v7.0.0 dist from source
#
# The v7.0.0 tag (d091a3c0) was committed with a stale dist/ build:
#   - CONTRACT_VERSION = '3.0.0' (should be '7.0.0')
#   - MIN_SUPPORTED_VERSION = '2.4.0' (should be '6.0.0')
#   - validators/billing.js missing entirely
#   - New modules (core, economy, governance, etc.) missing
#
# This script detects the stale dist and rebuilds from source.
# Remove when loa-hounfour publishes a properly-built tag.
#
# See: grimoires/loa/a2a/schema-audit-v5-v7.json (known_issues)

set -euo pipefail

PKG_DIR="node_modules/@0xhoneyjar/loa-hounfour"
VERSION_JS="$PKG_DIR/dist/version.js"
EXPECTED_SHA="d091a3c0d4802402825fc7765bcc888f2477742f"

# Skip if package not installed
if [ ! -d "$PKG_DIR" ]; then
  exit 0
fi

# Check if dist is stale by looking for CONTRACT_VERSION = '7.0.0'
if grep -q "CONTRACT_VERSION = '7.0.0'" "$VERSION_JS" 2>/dev/null; then
  # Already correct
  exit 0
fi

echo "Detected stale loa-hounfour dist (CONTRACT_VERSION != 7.0.0)"
echo "Rebuilding from source..."

# Clone the exact commit, build, and copy dist
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

git clone --depth 1 "https://github.com/0xHoneyJar/loa-hounfour.git" "$TMPDIR/repo" 2>/dev/null
cd "$TMPDIR/repo"
git fetch --depth 1 origin "$EXPECTED_SHA" 2>/dev/null
git checkout "$EXPECTED_SHA" 2>/dev/null

npm install --ignore-scripts 2>/dev/null
npx tsc 2>/dev/null

# Copy rebuilt dist
cd "$OLDPWD"
cp -r "$TMPDIR/repo/dist/"* "$PKG_DIR/dist/"

echo "loa-hounfour dist rebuilt successfully (CONTRACT_VERSION = 7.0.0)"
