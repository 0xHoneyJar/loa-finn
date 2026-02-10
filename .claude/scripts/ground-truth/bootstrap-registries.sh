#!/usr/bin/env bash
# bootstrap-registries.sh — Create starter registry files for Ground Truth
# Creates features.yaml, limitations.yaml, capability-taxonomy.yaml with TODO placeholders.
# These files MUST be reviewed and committed by a human before /ground-truth will run.
#
# Usage: bootstrap-registries.sh [--dir <path>]
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
