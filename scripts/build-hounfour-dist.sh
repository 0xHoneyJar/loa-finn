#!/usr/bin/env bash
# build-hounfour-dist.sh — Rebuild loa-hounfour dist from source
#
# The loa-hounfour GitHub tarball includes source but the committed dist/
# is flat (missing subpackage directories like core/, economy/, model/).
# This script rebuilds via tsc to produce the complete dist.
#
# This script replaces the old patch-hounfour-dist.sh and will be removed
# once the upstream repo adds a `prepare` script.

set -euo pipefail

PKG_DIR="node_modules/@0xhoneyjar/loa-hounfour"

# Check if dist is already complete (has core/ subdirectory)
if [[ -d "${PKG_DIR}/dist/core" && -d "${PKG_DIR}/dist/economy" ]]; then
  echo "[build-hounfour] dist already complete — skipping"
  exit 0
fi

echo "[build-hounfour] dist incomplete — rebuilding from source..."

# The GitHub tarball includes source at the repo root but pnpm strips it
# via the files field. We need to clone and build.
EXPECTED_VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${PKG_DIR}/package.json','utf8')).version)")
echo "[build-hounfour] Expected version: ${EXPECTED_VERSION}"

# Get the commit SHA from pnpm-lock.yaml resolution
COMMIT_SHA=$(node -e "
  const lock = require('fs').readFileSync('pnpm-lock.yaml', 'utf8');
  const match = lock.match(/loa-hounfour.*#([a-f0-9]{40})/);
  if (match) console.log(match[1]);
  else { console.error('Cannot find hounfour SHA in lockfile'); process.exit(1); }
")
echo "[build-hounfour] Building from commit: ${COMMIT_SHA}"

TMPDIR=$(mktemp -d)
trap "rm -rf ${TMPDIR}" EXIT

git clone --depth 1 "https://github.com/0xHoneyJar/loa-hounfour.git" "${TMPDIR}/repo" 2>/dev/null
cd "${TMPDIR}/repo"
git fetch --depth 1 origin "${COMMIT_SHA}" 2>/dev/null
git checkout "${COMMIT_SHA}" 2>/dev/null

# Install build deps and compile
npm install --ignore-scripts 2>/dev/null
npx tsc 2>/dev/null

# Verify version matches
BUILT_VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf8')).version)")
if [[ "${BUILT_VERSION}" != "${EXPECTED_VERSION}" ]]; then
  echo "[build-hounfour] WARNING: built version ${BUILT_VERSION} != expected ${EXPECTED_VERSION}"
fi

# Copy rebuilt dist (preserving existing files, adding missing subdirectories)
cd - >/dev/null
cp -r "${TMPDIR}/repo/dist/"* "${PKG_DIR}/dist/"

# Verify core subpackage exists
if [[ ! -f "${PKG_DIR}/dist/core/index.js" ]]; then
  echo "[build-hounfour] ERROR: dist/core/index.js missing after rebuild"
  exit 1
fi

echo "[build-hounfour] dist rebuilt successfully"
