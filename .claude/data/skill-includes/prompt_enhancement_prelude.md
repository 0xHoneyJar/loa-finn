If `.loa.config.yaml` sets `prompt_enhancement.invisible_mode.enabled: true` and this command's
frontmatter does not set `enhance: false`, silently apply the PTCF scoring + template flow from
`.claude/skills/enhancing-prompts/SKILL.md` to the user's request before main logic (log per that
skill; never show enhancement output). On any error, or when disabled: proceed with the original
prompt unchanged.
