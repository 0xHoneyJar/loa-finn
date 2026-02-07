// tests/finn/context-injection.test.ts — Context Injection tests (TASK-5.7)
// Self-contained: all types and functions inlined.

import assert from "node:assert/strict"

// ── Inlined types ──────────────────────────────────────────

interface PreviousResult {
  processedAt: string
  actionsTaken: string[]
  result: "success" | "failure" | "skipped"
  summary?: string
}

interface ChangeSummary {
  reason: "new" | "hash_changed" | "timer_expired"
  changedFields?: string[]
  previousHash?: string
  currentHash: string
  timeSinceLastReview?: string
}

interface ContextBlock {
  previousResult?: PreviousResult
  changeSummary?: ChangeSummary
  guidance: string
}

// ── Inlined buildContextBlock ──────────────────────────────

function buildContextBlock(opts: {
  previousResult?: PreviousResult
  changeSummary?: ChangeSummary
  itemKey: string
}): ContextBlock {
  const { previousResult, changeSummary } = opts
  let guidance: string
  if (!previousResult) {
    guidance = "This is a new item. Perform a thorough initial review."
  } else if (changeSummary?.reason === "hash_changed") {
    guidance = "This item has changed since your last review. Focus on what's different."
  } else if (changeSummary?.reason === "timer_expired") {
    guidance = "This item hasn't been reviewed recently. Perform a fresh review."
  } else {
    guidance = "This is a new item. Perform a thorough initial review."
  }
  return { previousResult, changeSummary, guidance }
}

// ── Inlined formatContextForPrompt ─────────────────────────

function formatContextForPrompt(block: ContextBlock): string {
  const sections: string[] = ["## Previous Context"]
  if (block.previousResult) {
    const pr = block.previousResult
    sections.push("")
    sections.push("### Last Review")
    sections.push(`- Processed: ${pr.processedAt}`)
    sections.push(`- Result: ${pr.result}`)
    sections.push(`- Actions: ${pr.actionsTaken.join(", ")}`)
    if (pr.summary) sections.push(`- Summary: ${pr.summary}`)
  }
  if (block.changeSummary) {
    const cs = block.changeSummary
    sections.push("")
    sections.push("### Changes Since Last Review")
    sections.push(`- Reason: ${cs.reason}`)
    if (cs.previousHash) sections.push(`- Previous hash: ${cs.previousHash}`)
    sections.push(`- Current hash: ${cs.currentHash}`)
    if (cs.timeSinceLastReview) sections.push(`- Time since last review: ${cs.timeSinceLastReview}`)
    if (cs.changedFields && cs.changedFields.length > 0) sections.push(`- Changed fields: ${cs.changedFields.join(", ")}`)
  }
  sections.push("")
  sections.push("### Guidance")
  sections.push(block.guidance)
  return sections.join("\n")
}

// ── Test harness ───────────────────────────────────────────

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  PASS  ${name}`)
  } catch (err) {
    console.error(`  FAIL  ${name}`)
    console.error(err)
    process.exitCode = 1
  }
}

// ── Tests ──────────────────────────────────────────────────

async function main() {
  console.log("Context Injection Tests")
  console.log("=======================")

  console.log("\n--- buildContextBlock ---")

  await test("buildContextBlock: new item (no previous result)", () => {
    const block = buildContextBlock({ itemKey: "pr-42", changeSummary: { reason: "new", currentHash: "abc123" } })
    assert.equal(block.guidance, "This is a new item. Perform a thorough initial review.")
    assert.equal(block.previousResult, undefined)
    assert.equal(block.changeSummary?.reason, "new")
  })

  await test("buildContextBlock: hash changed with previous result", () => {
    const prev: PreviousResult = { processedAt: "2026-02-01T00:00:00Z", actionsTaken: ["reviewed"], result: "success" }
    const cs: ChangeSummary = { reason: "hash_changed", previousHash: "old1", currentHash: "new1", changedFields: ["title"] }
    const block = buildContextBlock({ previousResult: prev, changeSummary: cs, itemKey: "pr-43" })
    assert.equal(block.guidance, "This item has changed since your last review. Focus on what's different.")
    assert.deepEqual(block.previousResult, prev)
    assert.deepEqual(block.changeSummary, cs)
  })

  await test("buildContextBlock: timer expired guidance", () => {
    const prev: PreviousResult = { processedAt: "2026-01-01T00:00:00Z", actionsTaken: ["triaged"], result: "skipped" }
    const cs: ChangeSummary = { reason: "timer_expired", currentHash: "same1", timeSinceLastReview: "3 days" }
    const block = buildContextBlock({ previousResult: prev, changeSummary: cs, itemKey: "issue-10" })
    assert.equal(block.guidance, "This item hasn't been reviewed recently. Perform a fresh review.")
  })

  console.log("\n--- formatContextForPrompt ---")

  await test("formatContextForPrompt: includes previous review section", () => {
    const block: ContextBlock = {
      previousResult: { processedAt: "2026-02-05T12:00:00Z", actionsTaken: ["lint", "approve"], result: "success" },
      guidance: "Some guidance",
    }
    const output = formatContextForPrompt(block)
    assert.ok(output.includes("### Last Review"))
    assert.ok(output.includes("- Processed: 2026-02-05T12:00:00Z"))
    assert.ok(output.includes("- Result: success"))
    assert.ok(output.includes("- Actions: lint, approve"))
  })

  await test("formatContextForPrompt: includes change summary", () => {
    const block: ContextBlock = {
      changeSummary: { reason: "hash_changed", previousHash: "aaa", currentHash: "bbb", changedFields: ["body", "labels"] },
      guidance: "Focus on changes.",
    }
    const output = formatContextForPrompt(block)
    assert.ok(output.includes("### Changes Since Last Review"))
    assert.ok(output.includes("- Reason: hash_changed"))
    assert.ok(output.includes("- Previous hash: aaa"))
    assert.ok(output.includes("- Current hash: bbb"))
    assert.ok(output.includes("- Changed fields: body, labels"))
  })

  await test("formatContextForPrompt: omits previous review when none exists", () => {
    const block: ContextBlock = {
      changeSummary: { reason: "new", currentHash: "xyz" },
      guidance: "New item.",
    }
    const output = formatContextForPrompt(block)
    assert.ok(!output.includes("### Last Review"), "Should not contain Last Review section")
    assert.ok(output.includes("### Changes Since Last Review"))
  })

  await test("formatContextForPrompt: includes guidance", () => {
    const block: ContextBlock = { guidance: "This is a new item. Perform a thorough initial review." }
    const output = formatContextForPrompt(block)
    assert.ok(output.includes("### Guidance"))
    assert.ok(output.includes("This is a new item. Perform a thorough initial review."))
  })

  await test("formatContextForPrompt: new item has no previous section", () => {
    const block = buildContextBlock({ itemKey: "issue-99", changeSummary: { reason: "new", currentHash: "h1" } })
    const output = formatContextForPrompt(block)
    assert.ok(!output.includes("### Last Review"), "New item should have no Last Review")
    assert.ok(output.includes("### Guidance"))
    assert.ok(output.includes("This is a new item. Perform a thorough initial review."))
  })

  console.log("\nDone.")
}

main()
