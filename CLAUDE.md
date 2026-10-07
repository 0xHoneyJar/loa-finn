@.claude/loa/CLAUDE.loa.md

# Project-Specific Instructions

> Project-specific customizations; these take precedence over the framework instructions imported above (framework updates modify `.claude/loa/CLAUDE.loa.md`, never this file).

## Context Intake Discipline (read FIRST at session start)

Before any substantive work, consult the known-failures **INDEX**, not the full log:

1. If `known_failures.surface_at_session_start` is `true`, the SessionStart hook (`loa-kf-surface.sh`) already printed the compact symptom → KF table (with recurrence) into this session — read it. Otherwise regenerate on demand: `bash .claude/scripts/grimoire-index.sh`, then read the `## kf` section of `grimoires/loa/INDEX.md`.
2. When a symptom matches what you are triaging, open `grimoires/loa/known-failures.md`, jump to that `## KF-NNN:` heading, and read only its **Reading guide** — the actionable next-step text that prevents re-attempting prior dead-ends.
3. Read the whole file only when authoring a NEW entry (dedup check) or repairing the ledger itself.

**Recurrence count ≥ 3** is the load-bearing signal — that failure class is structural; route through the upstream issue, do not retry the listed attempts.

Contribute every session (the ledger only works if it compounds): documented degradation observed → `bash .claude/scripts/lib/kf-write-lib.sh recur --id KF-NNN` + `kf-write-lib.sh attempt …` (evidence row: commit SHA / PR# / run ID); new degradation → `kf-write-lib.sh new …`. Sandbox tests with `--file <copy>`, never against the live ledger.

For code navigation, consult `grimoires/loa/REPO-MAP.md` (generated; `bash .claude/scripts/repo-map-gen.sh`) before broad grep sweeps of `.claude/`.

## Team & Ownership

- **Primary maintainer**: @deep-name
- **Default PR reviewer**: @deep-name — always request review from them
- **Repo**: 0xHoneyJar/loa
- **CODEOWNERS**: `.github/CODEOWNERS` handles auto-assignment on GitHub

## How This Works

1. Claude Code loads `@.claude/loa/CLAUDE.loa.md` first (framework instructions)
2. Then loads this file (project-specific instructions)
3. Instructions in this file **take precedence** over imported content
4. Framework updates modify `.claude/loa/CLAUDE.loa.md`, not this file

## Related Documentation

- `.loa.config.yaml` - User configuration file
- `PROCESS.md` - Detailed workflow documentation

## Construct Support

When `.run/construct-index.yaml` exists, constructs are installed and available:
- When a user mentions a construct name, check the index to resolve it
- Load the construct's persona file if available
- Scope to the construct's skill set and grimoire paths
- Use `construct-resolve.sh resolve <name>` for programmatic resolution
- Use `construct-resolve.sh compose <source> <target>` to check composition paths

## Model setup (operator directive 2026-10-05)

Main thread **Fable 5.1**, subagents **Opus 5.5**, both on Bedrock. Launch with `claude-bedrock -c`,
never plain `claude` (subscription Fable is out of credits; a plain session fails every turn).

- `.claude/settings.local.json` (gitignored, recreate per machine) carries
  `"model": "fable"` plus env `CLAUDE_CODE_SUBAGENT_MODEL=opus` and
  `ANTHROPIC_DEFAULT_OPUS_MODEL=global.anthropic.claude-opus-5-5`.
- `opus` MUST resolve to Opus 5.5: verify the id, never trust the alias. Both checks must name
  `global.anthropic.claude-opus-5-5`:
  1. `cd ~ && claude-bedrock -p --model opus --output-format json 'Reply with only the exact model ID named in your system prompt.' | jq '{result, models:(.modelUsage|keys)}'`
  2. In-session: spawn one Agent with `model: "opus"` and the same prompt.
- Subagent precedence: explicit `model` on the Agent call, then agent-definition frontmatter
  (`.claude/agents/*.md`, framework files, do not edit), then `CLAUDE_CODE_SUBAGENT_MODEL`, then inherit.
  `env` is read at launch; in a session started before the change, pass `model: "opus"` per Agent call.
- Headless Claude hops (Flatline primary, Bridgebuilder voice, chain-walk) use `claude-headless`, cheval's
  CLI adapter pinned to `cli_model: fable` and routed by `CLAUDE_HEADLESS_BIN` onto Bedrock. http_api ids
  (`opus`, `fable`) fail INVALID_CONFIG here: no `ANTHROPIC_API_KEY`. Secondary/tertiary Flatline voices stay
  non-Anthropic. Verified 2026-10-07.
