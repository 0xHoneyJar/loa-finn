// src/bridgebuilder/upstream.ts
// Single indirection module re-exporting all upstream bridgebuilder-review skill
// artifacts. This is the ONLY file in finn that uses #upstream-bridgebuilder/ specifiers.
//
// ADR: We chose Node.js subpath imports (#upstream-bridgebuilder/*) over:
//   - npm package: upstream skill lives in the same monorepo (.claude/skills/), no registry needed
//   - git submodule: adds operational complexity (recursive clone, submodule sync) for CI/CD
//   - copy-paste: duplicates code, defeats the purpose of skill extraction
// Tradeoff: subpath imports require package.json "imports" field and TypeScript NodeNext
// resolution, but give us compile-time type checking with zero-copy consumption.
// All upstream imports funnel through this file so changes to the upstream API surface
// require updating exactly one file — not every consumer in src/bridgebuilder/.

// === Core classes ===
export { ReviewPipeline } from "#upstream-bridgebuilder/core/reviewer.js"
export { PRReviewTemplate } from "#upstream-bridgebuilder/core/template.js"
export { BridgebuilderContext } from "#upstream-bridgebuilder/core/context.js"
export { truncateFiles, progressiveTruncate, estimateTokens, getTokenBudget } from "#upstream-bridgebuilder/core/truncation.js"

// === Core types ===
export type {
  BridgebuilderConfig,
  ReviewItem,
  ReviewResult,
  ReviewError,
  ErrorCategory,
  RunSummary,
  TruncationResult,
  LoaDetectionResult,
  SecurityPatternEntry,
  TokenBudget,
  ProgressiveTruncationResult,
  TokenEstimateBreakdown,
} from "#upstream-bridgebuilder/core/types.js"

export type { PromptPair } from "#upstream-bridgebuilder/core/template.js"

// === Port interfaces ===
export type {
  IGitProvider,
  IReviewPoster,
  ILLMProvider,
  IOutputSanitizer,
  IHasher,
  ILogger,
  IContextStore,
} from "#upstream-bridgebuilder/ports/index.js"

export type {
  PullRequest,
  PullRequestFile,
  PRReview,
  PreflightResult,
  RepoPreflightResult,
  GitProviderErrorCode,
  CommitCompareResult,
} from "#upstream-bridgebuilder/ports/git-provider.js"

export { GitProviderError } from "#upstream-bridgebuilder/ports/git-provider.js"

export type {
  ReviewRequest,
  ReviewResponse,
  LLMProviderErrorCode,
} from "#upstream-bridgebuilder/ports/llm-provider.js"

export { LLMProviderError } from "#upstream-bridgebuilder/ports/llm-provider.js"

export type {
  ReviewEvent,
  PostReviewInput,
} from "#upstream-bridgebuilder/ports/review-poster.js"

export type {
  SanitizationResult,
} from "#upstream-bridgebuilder/ports/output-sanitizer.js"

// === Adapter implementations ===
export { createLocalAdapters } from "#upstream-bridgebuilder/adapters/index.js"
export type { LocalAdapters, GitHubCLIAdapterConfig } from "#upstream-bridgebuilder/adapters/index.js"
export { GitHubCLIAdapter } from "#upstream-bridgebuilder/adapters/github-cli.js"
export { AnthropicAdapter } from "#upstream-bridgebuilder/adapters/anthropic.js"
export { PatternSanitizer } from "#upstream-bridgebuilder/adapters/sanitizer.js"
export { NoOpContextStore } from "#upstream-bridgebuilder/adapters/noop-context.js"
export { NodeHasher } from "#upstream-bridgebuilder/adapters/node-hasher.js"
export { ConsoleLogger } from "#upstream-bridgebuilder/adapters/console-logger.js"

// === Config ===
export { resolveConfig, parseCLIArgs, resolveRepos, formatEffectiveConfig } from "#upstream-bridgebuilder/config.js"
export type { CLIArgs, YamlConfig, EnvVars, ConfigSource, ConfigProvenance } from "#upstream-bridgebuilder/config.js"
