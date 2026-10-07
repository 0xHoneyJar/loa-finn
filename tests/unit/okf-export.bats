#!/usr/bin/env bats
# OKF/ICM cycle Sprint 4 — okf-export.sh (read-only OKF v0.1 export skin) coverage.
# Hermetic: builds a fixture grimoire so it never depends on the real (gitignored) corpus.
# cycle-121: observation export removed with the semantic-memory subsystem — the
# export surface is handoffs-only; redaction/robustness tests retargeted to handoffs.

setup() {
  BATS_TEST_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)"
  PROJECT_ROOT="$(cd "$BATS_TEST_DIR/../.." && pwd)"
  GEN="$PROJECT_ROOT/.claude/scripts/okf-export.sh"
  FIX="$(mktemp -d)"
  OUT="$(mktemp -d)/okf-bundle"
  mkdir -p "$FIX/handoffs"
  cat > "$FIX/handoffs/INDEX.md" <<'EOF'
# Handoff Index

| handoff_id | file | from | to | topic | ts_utc | read_by |
|------------|------|------|----|----|--------|---------|
| sha256:aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888 | 2026-06-01-alice-bob-cycle-test-context.md | alice | bob | cycle-test handoff | 2026-06-01T10:00:00Z |  |
| sha256:9999000011112222333344445555666677778888aaaabbbbccccddddeeeeffff | 2026-06-02-bob-carol-followup-context.md | bob | carol | followup work | 2026-06-02T11:00:00Z |  |
EOF
}

teardown() { rm -rf "$FIX" "$(dirname "$OUT")"; }

@test "okf-export: --json reports okf_version + counts + concepts + zero duplicate paths" {
  run bash "$GEN" --grimoire "$FIX" --json
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.okf_version=="0.1" and .counts.handoffs==2 and .counts.observations==0 and .counts.total==2' >/dev/null
  echo "$output" | jq -e '.concepts | length == 2' >/dev/null
  echo "$output" | jq -e '.duplicate_paths == 0' >/dev/null
}

@test "okf-export: --json is byte-deterministic across two runs" {
  run bash "$GEN" --grimoire "$FIX" --json; [ "$status" -eq 0 ]; local a="$output"
  run bash "$GEN" --grimoire "$FIX" --json; [ "$status" -eq 0 ]; [ "$a" = "$output" ]
}

@test "okf-export: write produces a byte-identical bundle on regen (deterministic)" {
  run bash "$GEN" --grimoire "$FIX" --output "$OUT" --quiet; [ "$status" -eq 0 ]
  local snap; snap="$(mktemp -d)"; cp -r "$OUT" "$snap/a"
  run bash "$GEN" --grimoire "$FIX" --output "$OUT" --quiet; [ "$status" -eq 0 ]
  run diff -r "$snap/a" "$OUT"
  [ "$status" -eq 0 ]
  rm -rf "$snap"
}

@test "okf-export: round-trips handoffs into concept files (disk == manifest)" {
  bash "$GEN" --grimoire "$FIX" --output "$OUT" --quiet
  [ "$(find "$OUT/handoffs" -name '*.md' ! -name index.md | wc -l | tr -d ' ')" -eq 2 ]
  local disk; disk="$(find "$OUT" -name '*.md' ! -name index.md | wc -l | tr -d ' ')"
  local man; man="$(bash "$GEN" --grimoire "$FIX" --json | jq -r '.counts.total')"
  [ "$disk" -eq "$man" ]
}

@test "okf-export: every non-reserved concept has frontmatter with a non-empty type" {
  bash "$GEN" --grimoire "$FIX" --output "$OUT" --quiet
  while IFS= read -r f; do
    [ "$(basename "$f")" = "index.md" ] && continue
    head -1 "$f" | grep -qx -- '---'
    grep -qE '^type: *"[^"]+"' "$f"
  done < <(find "$OUT" -name '*.md')
}

@test "okf-export: root index.md carries okf_version; sub-indexes carry NO frontmatter" {
  bash "$GEN" --grimoire "$FIX" --output "$OUT" --quiet
  grep -qE '^okf_version: *"0\.1"' "$OUT/index.md"
  run head -1 "$OUT/handoffs/index.md"; [ "$output" != "---" ]
}

@test "okf-export: path-as-identity — every concept file path matches its manifest path + .md" {
  run bash "$GEN" --grimoire "$FIX" --json; [ "$status" -eq 0 ]
  bash "$GEN" --grimoire "$FIX" --output "$OUT" --quiet
  while IFS= read -r p; do [ -f "$OUT/${p}.md" ]; done < <(echo "$output" | jq -r '.concepts[].path')
}

@test "okf-export: --validate passes on a freshly generated bundle" {
  bash "$GEN" --grimoire "$FIX" --output "$OUT" --quiet
  run bash "$GEN" --output "$OUT" --validate
  [ "$status" -eq 0 ]
}

@test "okf-export: --validate FAILS on a concept with an empty type (tamper)" {
  bash "$GEN" --grimoire "$FIX" --output "$OUT" --quiet
  local victim; victim="$(find "$OUT/handoffs" -name '*.md' ! -name index.md | head -1)"
  sed -i 's/^type: .*/type: ""/' "$victim"
  run bash "$GEN" --output "$OUT" --validate
  [ "$status" -ne 0 ]
  [[ "$output" == *"type"* ]]
}

@test "okf-export: secrets in a handoff TOPIC never leak (index, body, frontmatter)" {
  cat > "$FIX/handoffs/INDEX.md" <<'EOF'
# Handoff Index

| handoff_id | file | from | to | topic | ts_utc | read_by |
|------------|------|------|----|----|--------|---------|
| sha256:cccc1111dddd2222eeee3333ffff4444aaaa5555bbbb6666cccc7777dddd8888 | a-handoff.md | x | y | leak ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa and AKIAIOSFODNN7EXAMPLE here | 2026-06-05T00:00:00Z |  |
EOF
  bash "$GEN" --grimoire "$FIX" --output "$OUT" --quiet
  ! grep -rqE 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' "$OUT"
  ! grep -rqE 'AKIAIOSFODNN7EXAMPLE' "$OUT"
}

@test "okf-export: handoff rows sharing a filename basename get collision-disambiguated paths" {
  cat > "$FIX/handoffs/INDEX.md" <<'EOF'
# Handoff Index

| handoff_id | file | from | to | topic | ts_utc | read_by |
|------------|------|------|----|----|--------|---------|
| sha256:1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777aaaa8888bbbb | report.md | a | b | one | 2026-06-09T00:00:00Z |  |
| sha256:2222bbbb3333cccc4444dddd5555eeee6666ffff7777aaaa8888bbbb9999cccc | report.md | c | d | two | 2026-06-10T00:00:00Z |  |
EOF
  run bash "$GEN" --grimoire "$FIX" --json; [ "$status" -eq 0 ]
  echo "$output" | jq -e '.counts.handoffs==2 and .duplicate_paths==0' >/dev/null
}

@test "okf-export: a long topic with a trailing multibyte char yields valid UTF-8 .md files" {
  local longtopic; longtopic="$(printf 'A%.0s' $(seq 1 159))€"
  cat > "$FIX/handoffs/INDEX.md" <<EOF
# Handoff Index

| handoff_id | file | from | to | topic | ts_utc | read_by |
|------------|------|------|----|----|--------|---------|
| sha256:3333aaaa4444bbbb5555cccc6666dddd7777eeee8888ffff9999aaaa0000bbbb | long-topic.md | a | b | ${longtopic} | 2026-06-11T00:00:00Z |  |
EOF
  bash "$GEN" --grimoire "$FIX" --output "$OUT" --quiet
  while IFS= read -r f; do iconv -f UTF-8 -t UTF-8 "$f" >/dev/null 2>&1 || { echo "INVALID UTF-8: $f"; return 1; }; done < <(find "$OUT" -name '*.md')
  run bash "$GEN" --output "$OUT" --validate
  [ "$status" -eq 0 ]
}

@test "okf-export: path-traversal in a handoff filename cannot escape the bundle" {
  cat > "$FIX/handoffs/INDEX.md" <<'EOF'
# Handoff Index

| handoff_id | file | from | to | topic | ts_utc | read_by |
|------------|------|------|----|----|--------|---------|
| sha256:dead1111beef2222cafe3333babe4444feed5555face6666dead7777beef8888 | ../../../../etc/passwd | x | y | evil | 2026-06-09T00:00:00Z |  |
EOF
  bash "$GEN" --grimoire "$FIX" --output "$OUT" --quiet
  [ "$(find "$OUT/handoffs" -name '*.md' ! -name index.md | wc -l | tr -d ' ')" -eq 1 ]
  ! find "$OUT/handoffs" -name '*.md' -path '*etc*passwd*' | grep -q .
}

@test "okf-export: write REFUSES to clobber a populated non-bundle --output dir" {
  local danger; danger="$(mktemp -d)"
  echo "precious" > "$danger/keepme.txt"
  run bash "$GEN" --grimoire "$FIX" --output "$danger" --quiet
  [ "$status" -ne 0 ]
  [ -f "$danger/keepme.txt" ]   # untouched
  rm -rf "$danger"
}
