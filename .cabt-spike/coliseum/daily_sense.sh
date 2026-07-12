#!/usr/bin/env bash
# daily_sense.sh — the cabt META-ADAPTATION LOOP daily heartbeat (free, no slots, no engine).
# Runs the SENSE pass (drift poll + coliseum-corpus farm + meta-shift alert) and appends a timestamped
# report to sense-log.txt. When it flags a META-SHIFT, that's the cue to run an ADAPT pass:
#   1) design engine-legal variants with the gygax construct, 2) adapt_loop.py --adapt <spec.json>.
# Submissions stay operator-gated — this only SENSES + PROPOSES.
#
# Activate as a daily launchd job (9am):  launchctl load ~/Library/LaunchAgents/com.cabt.dailysense.plist
# (the plist calls this script). Or just run it by hand / each session. launchd env is minimal, so we set PATH.
set -euo pipefail
export PATH="/opt/homebrew/anaconda3/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/local/bin:$PATH"
REPO="/Users/zksoju/Documents/GitHub/loa-finn"
LOG="$REPO/.cabt-spike/coliseum/sense-log.txt"
cd "$REPO"
{
  echo "════════════════════════════════════════ $(date '+%Y-%m-%d %H:%M') ════"
  python3 .cabt-spike/coliseum/adapt_loop.py --sense 2>&1
  echo
} >> "$LOG" 2>&1
# surface the tail so an interactive run shows the result
tail -40 "$LOG"
