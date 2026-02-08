// src/bridgebuilder/upstream.ts
// Single indirection module re-exporting all upstream bridgebuilder-review skill
// artifacts. This is the ONLY file in finn that uses #upstream-bridgebuilder/ specifiers.

// === Core classes ===
export { ReviewPipeline } from "#upstream-bridgebuilder/core/reviewer.js"
export { PRReviewTemplate } from "#upstream-bridgebuilder/core/template.js"
export { BridgebuilderContext } from "#upstream-bridgebuilder/core/context.js"
export { truncateFiles } from "#upstream-bridgebuilder/core/truncation.js"

// === Core types ===
export type {
  BridgebuilderConfig,
  ReviewItem,
  ReviewResult,
  ReviewError,
  ErrorCategory,
  RunSummary,
  TruncationResult,
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
} from "#upstream-bridgebuilder/ports/git-provider.js"

export type {
  ReviewRequest,
  ReviewResponse,
} from "#upstream-bridgebuilder/ports/llm-provider.js"

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
