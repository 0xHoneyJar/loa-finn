#!/usr/bin/env bash
# generate-skill-includes.sh — single-source shared SKILL.md blocks (cycle-121)
#
# The 7 boilerplate blocks under .claude/data/skill-includes/*.md used to be
# hand-pasted across 7-10 skills (~21KB of drift-prone duplication). A skill
# opts in by carrying a marker pair inside the block's XML tags:
#
#   <context_discipline>
#   <!-- @skill-include: start context_discipline | hash:XXXXXXXX -->
#   ...generated body...
#   <!-- @skill-include: end context_discipline -->
#   </context_discipline>
#
# {{SKILL}} in a source file renders as the skill's directory name.
# hash = md5 of the rendered body (drift detection).
#
# Usage:
#   generate-skill-includes.sh --write   # re-render all opted-in blocks
#   generate-skill-includes.sh --check   # exit 1 if any block drifted
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
MODE="${1:---check}"
ROOT="${3:-.}"
if [[ "${2:-}" == "--root" ]]; then ROOT="${3:?--root needs a directory}"; fi
export MODE ROOT
python3 - <<'PYEOF'
import re, sys, glob, hashlib, os
mode = os.environ.get('MODE','--check')
root = os.environ.get('ROOT','.')
src_dir = os.path.join(root, '.claude/data/skill-includes')
sources = {os.path.basename(p)[:-3]: open(p).read().rstrip('\n') for p in glob.glob(f'{src_dir}/*.md')}
drift = []
changed = 0
pat = re.compile(r'(<!-- @skill-include: start (\w+) \| hash:([0-9a-f]{8})(?: \| DO NOT EDIT[^>]*)? -->\n)(.*?)(\n<!-- @skill-include: end \2 -->)', re.S)
for f in sorted(glob.glob(os.path.join(root, '.claude/skills/*/SKILL.md'))):
    skill = os.path.basename(os.path.dirname(f))
    s = open(f).read()
    out = s
    for m in list(pat.finditer(s)):
        name = m.group(2)
        if name not in sources:
            drift.append(f"{f}: marker references unknown include '{name}'")
            continue
        body = sources[name].replace('{{SKILL}}', skill)
        h = hashlib.md5(body.encode()).hexdigest()[:8]
        rendered = f'<!-- @skill-include: start {name} | hash:{h} | DO NOT EDIT — generated from .claude/data/skill-includes/{name}.md -->\n{body}\n<!-- @skill-include: end {name} -->'
        current = m.group(0)
        if current != rendered:
            if mode == '--write':
                out = out.replace(current, rendered)
                changed += 1
            else:
                drift.append(f"{f}: include '{name}' drifted (hash {m.group(3)} vs {h}, or body edited in place)")
    if out != s:
        open(f, 'w').write(out)
if mode == '--write':
    print(f"generate-skill-includes: {changed} block(s) rewritten")
    sys.exit(0)
if drift:
    print("generate-skill-includes: DRIFT DETECTED", file=sys.stderr)
    for d in drift: print(f"  {d}", file=sys.stderr)
    sys.exit(1)
print("generate-skill-includes: all opted-in blocks current")
PYEOF
