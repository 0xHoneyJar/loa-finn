// src/safety/secret-redactor.ts — Secret Redaction Patterns (TASK-3.4)
//
// Scans text for known secret patterns (GitHub tokens, AWS keys, generic API keys)
// and replaces them with typed [REDACTED:type] placeholders.

export interface RedactionPattern {
  name: string
  pattern: RegExp
  replacement: string
}

export class SecretRedactor {
  private patterns: RedactionPattern[]

  constructor(extraPatterns?: RedactionPattern[]) {
    this.patterns = [
      { name: "github-pat-classic", pattern: /ghp_[A-Za-z0-9_]{36,}/g, replacement: "[REDACTED:github-pat]" },
      { name: "github-pat-fine", pattern: /github_pat_[A-Za-z0-9_]{22,}/g, replacement: "[REDACTED:github-pat]" },
      { name: "github-app", pattern: /ghs_[A-Za-z0-9_]{36,}/g, replacement: "[REDACTED:github-app]" },
      { name: "github-oauth", pattern: /gho_[A-Za-z0-9_]{36,}/g, replacement: "[REDACTED:github-oauth]" },
      { name: "github-legacy", pattern: /v[0-9]+\.[a-f0-9]{40}/g, replacement: "[REDACTED:github-token]" },
      { name: "aws-key", pattern: /AKIA[0-9A-Z]{16}/g, replacement: "[REDACTED:aws-key]" },
      { name: "generic-key", pattern: /(?:key|token)=[a-f0-9]{32,}/gi, replacement: "[REDACTED:api-key]" },
      ...(extraPatterns ?? []),
    ]
  }

  redact(text: string): string {
    let result = text
    for (const p of this.patterns) {
      // Reset lastIndex for global regexps reused across calls
      p.pattern.lastIndex = 0
      result = result.replace(p.pattern, p.replacement)
    }
    return result
  }
}
