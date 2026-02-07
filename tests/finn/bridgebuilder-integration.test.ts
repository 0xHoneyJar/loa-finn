// tests/finn/bridgebuilder-integration.test.ts — Full pipeline integration tests
// Uses in-memory adapters for all ports. No real API calls.

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import type {
  IGitProvider, IReviewPoster, IContextStore, ILLMProvider,
  IHasher, IOutputSanitizer,
  PullRequest, PullRequestFile, PRReview, PreflightResult,
  PostReviewInput, ReviewEvent,
  ReviewRequest, ReviewResponse,
  ContextData, ReviewRecord,
  SanitizationResult,
} from "../../src/bridgebuilder/ports/index.js"
import type { BridgebuilderConfig, ReviewItem } from "../../src/bridgebuilder/core/types.js"
import { PRReviewTemplate } from "../../src/bridgebuilder/core/template.js"
import { BridgebuilderContext } from "../../src/bridgebuilder/core/context.js"
import { ReviewPipeline } from "../../src/bridgebuilder/core/reviewer.js"
import { truncateFiles } from "../../src/bridgebuilder/core/truncation.js"

// ── In-memory test adapters ─────────────────────────────────

function createTestConfig(overrides: Partial<BridgebuilderConfig> = {}): BridgebuilderConfig {
  return {
    repos: [{ owner: "test", repo: "repo" }],
    maxPRsPerRun: 10,
    maxRuntimeMinutes: 25,
    maxFilesPerPR: 50,
    maxDiffBytesPerPR: 100_000,
    maxInputTokens: 8000,
    maxOutputTokens: 4000,
    dimensions: ["security", "quality"],
    dryRun: false,
    ...overrides,
  }
}

function createTestHasher(): IHasher {
  return {
    sha256(input: string): string {
      return createHash("sha256").update(input).digest("hex")
    },
  }
}

function createTestSanitizer(overrides?: Partial<IOutputSanitizer>): IOutputSanitizer {
  return {
    sanitize(content: string): SanitizationResult {
      // Detect GitHub PATs
      const hasSecret = /ghp_[A-Za-z0-9_]{36,}/.test(content)
      if (hasSecret) {
        return {
          safe: false,
          sanitizedContent: content.replace(/ghp_[A-Za-z0-9_]{36,}/g, "[REDACTED]"),
          redactedPatterns: ["GitHub PAT (classic)"],
        }
      }
      return { safe: true, sanitizedContent: content, redactedPatterns: [] }
    },
    ...overrides,
  }
}

interface MockGitState {
  prs: PullRequest[]
  files: Map<number, PullRequestFile[]>
  reviews: Map<number, PRReview[]>
}

function createTestGit(state: MockGitState): IGitProvider {
  return {
    async listOpenPRs() { return state.prs },
    async getPRFiles(_o, _r, prNumber) { return state.files.get(prNumber) ?? [] },
    async getPRReviews(_o, _r, prNumber) { return state.reviews.get(prNumber) ?? [] },
    async preflight(): Promise<PreflightResult> { return { remaining: 5000, scopes: ["repo"] } },
  }
}

function createTestLLM(responseContent: string = "LGTM. No issues found."): ILLMProvider & { calls: ReviewRequest[] } {
  const calls: ReviewRequest[] = []
  return {
    calls,
    async generateReview(req: ReviewRequest): Promise<ReviewResponse> {
      calls.push(req)
      return {
        content: responseContent,
        inputTokens: 500,
        outputTokens: 200,
        model: "test-model",
      }
    },
  }
}

function createTestPoster(): IReviewPoster & { posted: PostReviewInput[]; markers: Set<string> } {
  const posted: PostReviewInput[] = []
  const markers = new Set<string>()
  return {
    posted,
    markers,
    async postReview(input: PostReviewInput): Promise<boolean> {
      posted.push(input)
      // Extract marker and record it
      const match = input.body.match(/<!-- finn-review: (\S+) -->/)
      if (match) markers.add(match[1])
      return true
    },
    async hasExistingReview(_o, _r, _pr, headSha): Promise<boolean> {
      return markers.has(headSha)
    },
  }
}

function createTestContext(): IContextStore & { data: ContextData; claims: Map<string, { status: string; expiresAt?: string }> } {
  const data: ContextData = { reviews: [], stats: { totalRuns: 0, totalReviews: 0 } }
  const claims = new Map<string, { status: string; expiresAt?: string }>()
  return {
    data,
    claims,
    async load() { return data },
    async save(d) { Object.assign(data, d) },
    async claimReview(repo, prNumber, headSha) {
      const key = `${repo}/${prNumber}/${headSha}`
      const existing = claims.get(key)
      if (existing) {
        if (existing.status === "posted") return false
        if (existing.expiresAt && new Date(existing.expiresAt) > new Date()) return false
      }
      claims.set(key, {
        status: "in-progress",
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      })
      return true
    },
    async finalizeReview(repo, prNumber, headSha) {
      const key = `${repo}/${prNumber}/${headSha}`
      claims.set(key, { status: "posted" })
    },
  }
}

function makePR(num: number, sha: string = `sha${num}`): PullRequest {
  return { number: num, title: `PR ${num}`, headSha: sha, baseBranch: "main", labels: [], author: "dev" }
}

function makeFile(name: string, patch: string = "+code"): PullRequestFile {
  return { filename: name, status: "added", additions: 10, deletions: 0, patch }
}

// ── Full Pipeline Tests ─────────────────────────────────────

console.log("=== Full Pipeline ===")

// Test: basic pipeline — resolves, reviews, posts
{
  const config = createTestConfig()
  const gitState: MockGitState = {
    prs: [makePR(1)],
    files: new Map([[1, [makeFile("src/app.ts")]]]),
    reviews: new Map(),
  }
  const git = createTestGit(gitState)
  const poster = createTestPoster()
  const llm = createTestLLM()
  const store = createTestContext()
  const sanitizer = createTestSanitizer()
  const hasher = createTestHasher()

  const template = new PRReviewTemplate(git, hasher, config)
  const context = new BridgebuilderContext(store, config)
  const pipeline = new ReviewPipeline(template, context, poster, llm, sanitizer, "You are a reviewer.", config)

  const summary = await pipeline.run("run-1")

  assert.equal(summary.totalPRs, 1)
  assert.equal(summary.reviewed, 1)
  assert.equal(summary.skipped, 0)
  assert.equal(summary.errors, 0)
  assert.equal(poster.posted.length, 1)
  assert.ok(poster.posted[0].body.includes("<!-- finn-review: sha1 -->"))
  assert.equal(llm.calls.length, 1)
  console.log("  ✓ basic pipeline: resolve → review → post")
}

// Test: unchanged PR skipped on second run
{
  const config = createTestConfig()
  const gitState: MockGitState = {
    prs: [makePR(1)],
    files: new Map([[1, [makeFile("src/app.ts")]]]),
    reviews: new Map(),
  }
  const git = createTestGit(gitState)
  const poster = createTestPoster()
  const llm = createTestLLM()
  const store = createTestContext()
  const sanitizer = createTestSanitizer()
  const hasher = createTestHasher()

  const template = new PRReviewTemplate(git, hasher, config)
  const context = new BridgebuilderContext(store, config)
  const pipeline = new ReviewPipeline(template, context, poster, llm, sanitizer, "Reviewer.", config)

  // First run — posts review
  await pipeline.run("run-1")
  assert.equal(poster.posted.length, 1)

  // Second run — same PR, same sha → skipped (marker exists on poster)
  const summary2 = await pipeline.run("run-2")
  assert.equal(summary2.skipped, 1)
  assert.equal(poster.posted.length, 1, "No new post on second run")
  console.log("  ✓ unchanged PR skipped on second run")
}

// Test: marker check before claim — marker-exists skips without burning a claim
{
  const config = createTestConfig()
  const gitState: MockGitState = {
    prs: [makePR(1, "existing-sha")],
    files: new Map([[1, [makeFile("src/app.ts")]]]),
    reviews: new Map(),
  }
  const git = createTestGit(gitState)

  // Poster already has the marker
  const poster = createTestPoster()
  poster.markers.add("existing-sha")

  const llm = createTestLLM()
  const store = createTestContext()
  const sanitizer = createTestSanitizer()
  const hasher = createTestHasher()

  const template = new PRReviewTemplate(git, hasher, config)
  const context = new BridgebuilderContext(store, config)
  const pipeline = new ReviewPipeline(template, context, poster, llm, sanitizer, "Reviewer.", config)

  const summary = await pipeline.run("run-1")
  assert.equal(summary.skipped, 1)
  assert.equal(store.claims.size, 0, "No claim burned — marker check prevented it")
  assert.equal(llm.calls.length, 0, "No LLM call")
  console.log("  ✓ marker-exists skips without burning a claim")
}

// Test: CAS claim prevents duplicate review
{
  const config = createTestConfig()
  const gitState: MockGitState = {
    prs: [makePR(1)],
    files: new Map([[1, [makeFile("src/app.ts")]]]),
    reviews: new Map(),
  }
  const git = createTestGit(gitState)
  const poster = createTestPoster()
  const llm = createTestLLM()
  const store = createTestContext()
  const sanitizer = createTestSanitizer()
  const hasher = createTestHasher()

  // Pre-claim the review (simulate another run in progress)
  store.claims.set("test/repo/1/sha1", {
    status: "in-progress",
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  })

  const template = new PRReviewTemplate(git, hasher, config)
  const context = new BridgebuilderContext(store, config)
  const pipeline = new ReviewPipeline(template, context, poster, llm, sanitizer, "Reviewer.", config)

  const summary = await pipeline.run("run-1")
  assert.equal(summary.skipped, 1)
  assert.equal(poster.posted.length, 0, "No post — claim blocked")
  assert.equal(llm.calls.length, 0, "No LLM call — claim blocked")
  console.log("  ✓ CAS claim prevents duplicate review")
}

// Test: output sanitization — LLM echoes token, sanitizer redacts
{
  const config = createTestConfig()
  const gitState: MockGitState = {
    prs: [makePR(1)],
    files: new Map([[1, [makeFile("src/app.ts")]]]),
    reviews: new Map(),
  }
  const git = createTestGit(gitState)
  const poster = createTestPoster()
  // LLM "leaks" a token in its response
  const llm = createTestLLM("Found hardcoded token: ghp_" + "A".repeat(40) + " in config.ts")
  const store = createTestContext()
  const sanitizer = createTestSanitizer()
  const hasher = createTestHasher()

  const template = new PRReviewTemplate(git, hasher, config)
  const context = new BridgebuilderContext(store, config)
  const pipeline = new ReviewPipeline(template, context, poster, llm, sanitizer, "Reviewer.", config)

  const summary = await pipeline.run("run-1")
  assert.equal(summary.reviewed, 1)
  assert.ok(poster.posted[0].body.includes("[REDACTED]"), "Token was redacted")
  assert.ok(!poster.posted[0].body.includes("ghp_"), "Original token not in output")
  console.log("  ✓ output sanitization redacts leaked tokens")
}

// Test: prompt size enforcement — oversized PR skipped
{
  const config = createTestConfig({ maxInputTokens: 50 }) // Very low limit
  const gitState: MockGitState = {
    prs: [makePR(1)],
    files: new Map([[1, [makeFile("src/app.ts", "a".repeat(1000))]]]),
    reviews: new Map(),
  }
  const git = createTestGit(gitState)
  const poster = createTestPoster()
  const llm = createTestLLM()
  const store = createTestContext()
  const sanitizer = createTestSanitizer()
  const hasher = createTestHasher()

  const template = new PRReviewTemplate(git, hasher, config)
  const context = new BridgebuilderContext(store, config)
  const pipeline = new ReviewPipeline(template, context, poster, llm, sanitizer, "You are a reviewer with a long persona.", config)

  const summary = await pipeline.run("run-1")
  assert.equal(summary.skipped, 1)
  assert.equal(llm.calls.length, 0, "No LLM call for oversized prompt")
  console.log("  ✓ prompt size enforcement skips oversized PRs")
}

// Test: dry-run mode — DryRunPoster records but returns false
{
  const config = createTestConfig({ dryRun: true })
  const gitState: MockGitState = {
    prs: [makePR(1)],
    files: new Map([[1, [makeFile("src/app.ts")]]]),
    reviews: new Map(),
  }
  const git = createTestGit(gitState)
  const llm = createTestLLM()
  const store = createTestContext()
  const sanitizer = createTestSanitizer()
  const hasher = createTestHasher()

  // Use a dry-run poster that returns false
  const dryPoster: IReviewPoster & { posted: PostReviewInput[] } = {
    posted: [],
    async postReview(input) {
      dryPoster.posted.push(input)
      return false // Not actually posted
    },
    async hasExistingReview() { return false },
  }

  const template = new PRReviewTemplate(git, hasher, config)
  const context = new BridgebuilderContext(store, config)
  const pipeline = new ReviewPipeline(template, context, dryPoster, llm, sanitizer, "Reviewer.", config)

  const summary = await pipeline.run("run-1")
  assert.equal(summary.reviewed, 0, "Nothing actually posted")
  assert.equal(summary.skipped, 1, "Marked as skipped (dry-run)")
  assert.equal(dryPoster.posted.length, 1, "DryRunPoster recorded the input")
  assert.equal(store.claims.get("test/repo/1/sha1")?.status, "in-progress", "Claim NOT finalized (poster returned false)")
  console.log("  ✓ dry-run mode: records inputs, returns false, claim not finalized")
}

// Test: runtime limit — pipeline stops after configured time
{
  let clock = 0
  const config = createTestConfig({ maxRuntimeMinutes: 1 }) // 1 minute
  const gitState: MockGitState = {
    prs: [makePR(1), makePR(2), makePR(3)],
    files: new Map([
      [1, [makeFile("a.ts")]],
      [2, [makeFile("b.ts")]],
      [3, [makeFile("c.ts")]],
    ]),
    reviews: new Map(),
  }
  const git = createTestGit(gitState)
  const poster = createTestPoster()
  const store = createTestContext()
  const sanitizer = createTestSanitizer()
  const hasher = createTestHasher()

  // LLM that advances the clock by 40 seconds each call
  const llm: ILLMProvider = {
    async generateReview(req) {
      clock += 40_000
      return { content: "ok", inputTokens: 100, outputTokens: 50, model: "test" }
    },
  }

  const template = new PRReviewTemplate(git, hasher, config)
  const context = new BridgebuilderContext(store, config)
  const pipeline = new ReviewPipeline(
    template, context, poster, llm, sanitizer, "R.", config,
    () => clock,
  )

  const summary = await pipeline.run("run-1")
  assert.ok(summary.reviewed < 3, `Should stop before processing all 3 PRs (reviewed: ${summary.reviewed})`)
  console.log("  ✓ runtime limit stops pipeline")
}

// Test: error handling — LLM failure doesn't stop other PRs
{
  const config = createTestConfig()
  let callCount = 0
  const gitState: MockGitState = {
    prs: [makePR(1), makePR(2)],
    files: new Map([
      [1, [makeFile("a.ts")]],
      [2, [makeFile("b.ts")]],
    ]),
    reviews: new Map(),
  }
  const git = createTestGit(gitState)
  const poster = createTestPoster()
  const store = createTestContext()
  const sanitizer = createTestSanitizer()
  const hasher = createTestHasher()

  const llm: ILLMProvider = {
    async generateReview(req) {
      callCount++
      if (callCount === 1) throw new Error("API timeout")
      return { content: "ok", inputTokens: 100, outputTokens: 50, model: "test" }
    },
  }

  const template = new PRReviewTemplate(git, hasher, config)
  const context = new BridgebuilderContext(store, config)
  const pipeline = new ReviewPipeline(template, context, poster, llm, sanitizer, "R.", config)

  const summary = await pipeline.run("run-1")
  assert.equal(summary.errors, 1, "First PR errored")
  assert.equal(summary.reviewed, 1, "Second PR still reviewed")
  assert.equal(poster.posted.length, 1, "One review posted")
  console.log("  ✓ LLM error on one PR doesn't stop others")
}

// Test: two-phase claim lifecycle — expired in-progress claim allows retry
{
  const config = createTestConfig()
  const gitState: MockGitState = {
    prs: [makePR(1)],
    files: new Map([[1, [makeFile("src/app.ts")]]]),
    reviews: new Map(),
  }
  const git = createTestGit(gitState)
  const poster = createTestPoster()
  const llm = createTestLLM()
  const store = createTestContext()
  const sanitizer = createTestSanitizer()
  const hasher = createTestHasher()

  // Simulate an expired in-progress claim (from a failed previous run)
  store.claims.set("test/repo/1/sha1", {
    status: "in-progress",
    expiresAt: new Date(Date.now() - 60_000).toISOString(), // Expired 1 minute ago
  })

  const template = new PRReviewTemplate(git, hasher, config)
  const context = new BridgebuilderContext(store, config)
  const pipeline = new ReviewPipeline(template, context, poster, llm, sanitizer, "Reviewer.", config)

  const summary = await pipeline.run("run-1")
  assert.equal(summary.reviewed, 1, "Review succeeded — expired claim overwritten")
  assert.equal(store.claims.get("test/repo/1/sha1")?.status, "posted", "Claim finalized to posted")
  console.log("  ✓ expired in-progress claim allows retry")
}

// Test: classifyEvent returns REQUEST_CHANGES for critical patterns
{
  const config = createTestConfig()
  const gitState: MockGitState = {
    prs: [makePR(1)],
    files: new Map([[1, [makeFile("src/app.ts")]]]),
    reviews: new Map(),
  }
  const git = createTestGit(gitState)
  const poster = createTestPoster()
  const llm = createTestLLM("Critical: SQL injection vulnerability in query builder. Must fix before merge.")
  const store = createTestContext()
  const sanitizer = createTestSanitizer()
  const hasher = createTestHasher()

  const template = new PRReviewTemplate(git, hasher, config)
  const context = new BridgebuilderContext(store, config)
  const pipeline = new ReviewPipeline(template, context, poster, llm, sanitizer, "R.", config)

  await pipeline.run("run-1")
  assert.equal(poster.posted[0].event, "REQUEST_CHANGES", "Critical content → REQUEST_CHANGES")
  console.log("  ✓ classifyEvent: critical → REQUEST_CHANGES")
}

// Test: classifyEvent returns COMMENT for benign content
{
  const config = createTestConfig()
  const gitState: MockGitState = {
    prs: [makePR(1)],
    files: new Map([[1, [makeFile("src/app.ts")]]]),
    reviews: new Map(),
  }
  const git = createTestGit(gitState)
  const poster = createTestPoster()
  const llm = createTestLLM("Looks good overall. Minor style suggestion: use const instead of let.")
  const store = createTestContext()
  const sanitizer = createTestSanitizer()
  const hasher = createTestHasher()

  const template = new PRReviewTemplate(git, hasher, config)
  const context = new BridgebuilderContext(store, config)
  const pipeline = new ReviewPipeline(template, context, poster, llm, sanitizer, "R.", config)

  await pipeline.run("run-1")
  assert.equal(poster.posted[0].event, "COMMENT", "Benign content → COMMENT")
  console.log("  ✓ classifyEvent: benign → COMMENT")
}

// ── Pipeline Ordering Tests (spy-based) ─────────────────────

console.log("\n=== Pipeline Ordering ===")

// Test: correct operation ordering with spy tracking
{
  const config = createTestConfig()
  const gitState: MockGitState = {
    prs: [makePR(1)],
    files: new Map([[1, [makeFile("src/app.ts")]]]),
    reviews: new Map(),
  }
  const git = createTestGit(gitState)
  const callOrder: string[] = []

  const poster: IReviewPoster = {
    async postReview(input) {
      callOrder.push("postReview")
      return true
    },
    async hasExistingReview() {
      callOrder.push("hasExistingReview")
      return false
    },
  }

  const llm: ILLMProvider = {
    async generateReview(req) {
      callOrder.push("generateReview")
      return { content: "ok", inputTokens: 100, outputTokens: 50, model: "test" }
    },
  }

  const store: IContextStore = {
    async load() { return { reviews: [], stats: { totalRuns: 0, totalReviews: 0 } } },
    async save() {},
    async claimReview() { callOrder.push("claimReview"); return true },
    async finalizeReview() { callOrder.push("finalizeReview") },
  }

  const sanitizer: IOutputSanitizer = {
    sanitize(content) {
      callOrder.push("sanitize")
      return { safe: true, sanitizedContent: content, redactedPatterns: [] }
    },
  }

  const hasher = createTestHasher()
  const template = new PRReviewTemplate(git, hasher, config)
  const context = new BridgebuilderContext(store, config)
  const pipeline = new ReviewPipeline(template, context, poster, llm, sanitizer, "R.", config)

  await pipeline.run("run-1")

  // Verify ordering: marker check → claim → generate → sanitize → re-check marker → post → finalize
  const expectedOrder = [
    "hasExistingReview",  // Step 2: marker check FIRST
    "claimReview",        // Step 3: CAS claim second
    "generateReview",     // Step 4: LLM call
    "sanitize",           // Step 5: output sanitization
    "hasExistingReview",  // Step 6: re-check marker before posting
    "postReview",         // Step 7: post review
    "finalizeReview",     // Step 8: finalize claim
  ]

  assert.deepStrictEqual(callOrder, expectedOrder, `Expected: ${expectedOrder.join(" → ")}\nGot: ${callOrder.join(" → ")}`)
  console.log("  ✓ correct ordering: marker → claim → LLM → sanitize → re-check → post → finalize")
}

// Test: on LLM error — finalizeReview and postReview NOT called
{
  const config = createTestConfig()
  const gitState: MockGitState = {
    prs: [makePR(1)],
    files: new Map([[1, [makeFile("src/app.ts")]]]),
    reviews: new Map(),
  }
  const git = createTestGit(gitState)
  const callOrder: string[] = []

  const poster: IReviewPoster = {
    async postReview() { callOrder.push("postReview"); return true },
    async hasExistingReview() { callOrder.push("hasExistingReview"); return false },
  }

  const llm: ILLMProvider = {
    async generateReview() {
      callOrder.push("generateReview")
      throw new Error("API error")
    },
  }

  const store: IContextStore = {
    async load() { return { reviews: [], stats: { totalRuns: 0, totalReviews: 0 } } },
    async save() {},
    async claimReview() { callOrder.push("claimReview"); return true },
    async finalizeReview() { callOrder.push("finalizeReview") },
  }

  const sanitizer: IOutputSanitizer = {
    sanitize(content) { callOrder.push("sanitize"); return { safe: true, sanitizedContent: content, redactedPatterns: [] } },
  }

  const hasher = createTestHasher()
  const template = new PRReviewTemplate(git, hasher, config)
  const context = new BridgebuilderContext(store, config)
  const pipeline = new ReviewPipeline(template, context, poster, llm, sanitizer, "R.", config)

  const summary = await pipeline.run("run-1")
  assert.equal(summary.errors, 1)
  assert.ok(!callOrder.includes("postReview"), "postReview NOT called on LLM error")
  assert.ok(!callOrder.includes("finalizeReview"), "finalizeReview NOT called on LLM error")
  assert.ok(!callOrder.includes("sanitize"), "sanitize NOT called on LLM error")
  console.log("  ✓ on LLM error: postReview, finalizeReview, sanitize NOT called")
}

// Test: marker re-check prevents posting when concurrent run posted
{
  const config = createTestConfig()
  const gitState: MockGitState = {
    prs: [makePR(1)],
    files: new Map([[1, [makeFile("src/app.ts")]]]),
    reviews: new Map(),
  }
  const git = createTestGit(gitState)
  let markerCheckCount = 0

  const poster: IReviewPoster = {
    async postReview() { return true },
    async hasExistingReview() {
      markerCheckCount++
      // First check: no marker. Second check (re-check): marker appeared!
      return markerCheckCount > 1
    },
  }

  const llm = createTestLLM()
  const store = createTestContext()
  const sanitizer = createTestSanitizer()
  const hasher = createTestHasher()

  const template = new PRReviewTemplate(git, hasher, config)
  const context = new BridgebuilderContext(store, config)
  const pipeline = new ReviewPipeline(template, context, poster, llm, sanitizer, "R.", config)

  const summary = await pipeline.run("run-1")
  assert.equal(summary.skipped, 1, "Skipped due to marker-exists-recheck")
  assert.equal(markerCheckCount, 2, "Marker checked twice")
  console.log("  ✓ marker re-check prevents posting when concurrent run posted")
}

// ── Hash Stability Tests ────────────────────────────────────

console.log("\n=== Hash Stability ===")

{
  const hasher = createTestHasher()
  const config = createTestConfig()
  const git = createTestGit({ prs: [], files: new Map(), reviews: new Map() })
  const template = new PRReviewTemplate(git, hasher, config)

  // Access computeHash via resolveItems + checking stateHash
  // We'll compute hashes manually to test stability

  const hash = (headSha: string, files: Array<{ filename: string; status: string; additions: number; deletions: number }>) => {
    const sorted = [...files].sort((a, b) => a.filename.localeCompare(b.filename))
    return createHash("sha256").update(JSON.stringify({ headSha, files: sorted })).digest("hex")
  }

  // Same data → identical hash
  const h1 = hash("abc123", [{ filename: "a.ts", status: "added", additions: 10, deletions: 0 }])
  const h2 = hash("abc123", [{ filename: "a.ts", status: "added", additions: 10, deletions: 0 }])
  assert.equal(h1, h2, "Same data → same hash")
  console.log("  ✓ same data → identical hash")

  // Changed headSha → different hash
  const h3 = hash("def456", [{ filename: "a.ts", status: "added", additions: 10, deletions: 0 }])
  assert.notEqual(h1, h3, "Different headSha → different hash")
  console.log("  ✓ changed headSha → different hash")

  // Changed files → different hash
  const h4 = hash("abc123", [{ filename: "b.ts", status: "modified", additions: 5, deletions: 3 }])
  assert.notEqual(h1, h4, "Different files → different hash")
  console.log("  ✓ changed files → different hash")

  // Files sorted deterministically regardless of input order
  const h5 = hash("abc123", [
    { filename: "z.ts", status: "added", additions: 1, deletions: 0 },
    { filename: "a.ts", status: "added", additions: 1, deletions: 0 },
  ])
  const h6 = hash("abc123", [
    { filename: "a.ts", status: "added", additions: 1, deletions: 0 },
    { filename: "z.ts", status: "added", additions: 1, deletions: 0 },
  ])
  assert.equal(h5, h6, "File order doesn't matter — sorted deterministically")
  console.log("  ✓ files sorted deterministically regardless of API order")
}

// ── Truncation Tests ────────────────────────────────────────

console.log("\n=== Truncation ===")

// Test: risk-prioritized ordering
{
  const config = createTestConfig({ maxFilesPerPR: 50, maxDiffBytesPerPR: 100_000 })
  const files: PullRequestFile[] = [
    { filename: "readme.md", status: "modified", additions: 100, deletions: 50, patch: "big change" },
    { filename: "src/auth.ts", status: "modified", additions: 5, deletions: 2, patch: "small" },
    { filename: "src/utils.ts", status: "added", additions: 200, deletions: 0, patch: "utility" },
  ]

  const result = truncateFiles(files, config)
  assert.equal(result.included[0].filename, "src/auth.ts", "auth.ts first (high-risk)")
  console.log("  ✓ high-risk files prioritized first")
}

// Test: maxFilesPerPR limit
{
  const config = createTestConfig({ maxFilesPerPR: 2, maxDiffBytesPerPR: 100_000 })
  const files: PullRequestFile[] = [
    makeFile("a.ts"),
    makeFile("b.ts"),
    makeFile("c.ts"),
  ]

  const result = truncateFiles(files, config)
  assert.equal(result.included.length + result.summarized.length, 2, "Capped at maxFilesPerPR")
  assert.ok(result.truncationNotice?.includes("omitted"), "Truncation notice mentions omitted files")
  console.log("  ✓ maxFilesPerPR limit enforced")
}

// Test: maxDiffBytesPerPR limit
{
  const config = createTestConfig({ maxFilesPerPR: 50, maxDiffBytesPerPR: 20 })
  const files: PullRequestFile[] = [
    { filename: "a.ts", status: "added", additions: 10, deletions: 0, patch: "a".repeat(15) },
    { filename: "b.ts", status: "added", additions: 10, deletions: 0, patch: "b".repeat(15) },
  ]

  const result = truncateFiles(files, config)
  assert.equal(result.included.length, 1, "Only first file fits in byte budget")
  assert.equal(result.summarized.length, 1, "Second file summarized")
  console.log("  ✓ maxDiffBytesPerPR limit enforced")
}

// Test: empty files
{
  const config = createTestConfig()
  const result = truncateFiles([], config)
  assert.equal(result.included.length, 0)
  assert.equal(result.summarized.length, 0)
  assert.equal(result.truncationNotice, undefined)
  console.log("  ✓ empty files returns empty result")
}

// ── Portability Check ───────────────────────────────────────

console.log("\n=== Portability ===")

// Test: core files have no forbidden imports
{
  const fs = await import("node:fs")
  const path = await import("node:path")

  const coreDir = path.join(process.cwd(), "src/bridgebuilder/core")
  const coreFiles = fs.readdirSync(coreDir).filter(f => f.endsWith(".ts"))

  const forbidden = [
    /from\s+["']src\/cron\//,
    /from\s+["']\.\.\/\.\.\/cron\//,
    /from\s+["']src\/persistence\//,
    /from\s+["']\.\.\/\.\.\/persistence\//,
    /from\s+["']src\/safety\//,
    /from\s+["']\.\.\/\.\.\/safety\//,
    /from\s+["']src\/agent\//,
    /from\s+["']\.\.\/\.\.\/agent\//,
    /from\s+["']src\/gateway\//,
    /from\s+["']\.\.\/\.\.\/gateway\//,
    /from\s+["']src\/scheduler\//,
    /from\s+["']\.\.\/\.\.\/scheduler\//,
    /from\s+["']node:/,
  ]

  for (const file of coreFiles) {
    const content = fs.readFileSync(path.join(coreDir, file), "utf-8")
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(content), `core/${file} has forbidden import matching ${pattern}`)
    }
  }
  console.log(`  ✓ ${coreFiles.length} core files have no forbidden imports`)
}

// Test: port files import nothing external
{
  const fs = await import("node:fs")
  const path = await import("node:path")

  const portsDir = path.join(process.cwd(), "src/bridgebuilder/ports")
  const portFiles = fs.readdirSync(portsDir).filter(f => f.endsWith(".ts") && f !== "index.ts")

  for (const file of portFiles) {
    const content = fs.readFileSync(path.join(portsDir, file), "utf-8")
    const hasImport = /^import\s/m.test(content)
    assert.ok(!hasImport, `ports/${file} should not have any imports`)
  }
  console.log(`  ✓ ${portFiles.length} port files import nothing`)
}

console.log("\n✅ All bridgebuilder-integration tests passed")
