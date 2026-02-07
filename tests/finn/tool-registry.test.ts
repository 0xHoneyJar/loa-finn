// tests/finn/tool-registry.test.ts — MCP Tool Registry tests (SDD §4.2)

import assert from "node:assert/strict"
import {
  TOOL_REGISTRY,
  getToolEntry,
  getToolCapability,
  isKnownTool,
  getToolsByCapability,
  validateToolRegistry,
  validateParams,
} from "../../src/safety/tool-registry.js"
import type { ToolCapability } from "../../src/safety/tool-registry.js"

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

async function main() {
  console.log("MCP Tool Registry Tests")
  console.log("=======================")

  // ── 1. Known Tool Lookup ──────────────────────────────────

  console.log("\n--- Known Tool Lookup ---")

  await test("getToolEntry returns entry for known read tool", () => {
    const entry = getToolEntry("get_pull_request")
    assert.ok(entry)
    assert.equal(entry.name, "get_pull_request")
    assert.equal(entry.capability, "read")
  })

  await test("getToolEntry returns entry for known write tool", () => {
    const entry = getToolEntry("create_issue")
    assert.ok(entry)
    assert.equal(entry.name, "create_issue")
    assert.equal(entry.capability, "write")
  })

  await test("getToolEntry returns entry for known admin tool", () => {
    const entry = getToolEntry("merge_pull_request")
    assert.ok(entry)
    assert.equal(entry.name, "merge_pull_request")
    assert.equal(entry.capability, "admin")
  })

  await test("getToolEntry returns undefined for unknown tool", () => {
    const entry = getToolEntry("totally_fake_tool")
    assert.equal(entry, undefined)
  })

  await test("getToolCapability returns correct capability", () => {
    assert.equal(getToolCapability("get_issue"), "read")
    assert.equal(getToolCapability("add_issue_comment"), "write")
    assert.equal(getToolCapability("delete_branch"), "admin")
  })

  await test("getToolCapability returns undefined for unknown tool", () => {
    assert.equal(getToolCapability("nonexistent"), undefined)
  })

  // ── 2. Unknown Tool Detection ─────────────────────────────

  console.log("\n--- Unknown Tool Detection ---")

  await test("isKnownTool returns true for registry tools", () => {
    assert.equal(isKnownTool("get_pull_request"), true)
    assert.equal(isKnownTool("push_files"), true)
    assert.equal(isKnownTool("merge_pull_request"), true)
  })

  await test("isKnownTool returns false for unknown tools", () => {
    assert.equal(isKnownTool("hack_the_planet"), false)
    assert.equal(isKnownTool(""), false)
    assert.equal(isKnownTool("GET_PULL_REQUEST"), false) // case-sensitive
  })

  // ── 3. Capability Classification ──────────────────────────

  console.log("\n--- Capability Classification ---")

  await test("all read tools are classified correctly", () => {
    const readTools = [
      "get_pull_request", "get_pull_request_files", "get_pull_request_comments",
      "get_pull_request_reviews", "list_pull_requests", "get_issue", "list_issues",
      "search_issues", "search_code", "get_file_contents", "list_commits",
      "get_pull_request_status",
    ]
    for (const name of readTools) {
      assert.equal(getToolCapability(name), "read", `Expected ${name} to be read`)
    }
  })

  await test("all write tools are classified correctly", () => {
    const writeTools = [
      "create_pull_request_review", "add_issue_comment", "update_issue",
      "create_issue", "create_pull_request", "create_branch",
      "create_or_update_file", "push_files",
    ]
    for (const name of writeTools) {
      assert.equal(getToolCapability(name), "write", `Expected ${name} to be write`)
    }
  })

  await test("all admin tools are classified correctly", () => {
    const adminTools = [
      "merge_pull_request", "delete_branch", "update_branch_protection",
      "update_pull_request_branch",
    ]
    for (const name of adminTools) {
      assert.equal(getToolCapability(name), "admin", `Expected ${name} to be admin`)
    }
  })

  await test("getToolsByCapability returns correct read tools", () => {
    const readTools = getToolsByCapability("read")
    assert.equal(readTools.length, 12)
    assert.ok(readTools.includes("get_pull_request"))
    assert.ok(readTools.includes("search_code"))
    assert.ok(readTools.includes("get_pull_request_status"))
  })

  await test("getToolsByCapability returns correct write tools", () => {
    const writeTools = getToolsByCapability("write")
    assert.equal(writeTools.length, 8)
    assert.ok(writeTools.includes("create_pull_request"))
    assert.ok(writeTools.includes("push_files"))
  })

  await test("getToolsByCapability returns correct admin tools", () => {
    const adminTools = getToolsByCapability("admin")
    assert.equal(adminTools.length, 4)
    assert.ok(adminTools.includes("merge_pull_request"))
    assert.ok(adminTools.includes("update_branch_protection"))
  })

  await test("registry covers expected total count", () => {
    assert.equal(TOOL_REGISTRY.size, 24)
  })

  // ── 4. validateToolRegistry ───────────────────────────────

  console.log("\n--- validateToolRegistry ---")

  await test("validates all known tools as valid", () => {
    const knownNames = Array.from(TOOL_REGISTRY.keys())
    const result = validateToolRegistry(knownNames)
    assert.equal(result.valid, true)
    assert.equal(result.unknownTools.length, 0)
  })

  await test("detects unknown tools", () => {
    const toolNames = ["get_pull_request", "evil_tool", "another_bad_one"]
    const result = validateToolRegistry(toolNames)
    assert.equal(result.valid, false)
    assert.deepEqual(result.unknownTools, ["evil_tool", "another_bad_one"])
  })

  await test("empty list is valid", () => {
    const result = validateToolRegistry([])
    assert.equal(result.valid, true)
    assert.equal(result.unknownTools.length, 0)
  })

  await test("single unknown tool fails validation", () => {
    const result = validateToolRegistry(["unknown_tool"])
    assert.equal(result.valid, false)
    assert.deepEqual(result.unknownTools, ["unknown_tool"])
  })

  // ── 5. Param Constraint Validation ────────────────────────

  console.log("\n--- Param Constraint Validation ---")

  // create_pull_request: draft must_be true
  await test("create_pull_request with draft=true passes", () => {
    const result = validateParams("create_pull_request", { draft: true, title: "WIP" })
    assert.equal(result.valid, true)
    assert.equal(result.violations.length, 0)
  })

  await test("create_pull_request with draft=false fails", () => {
    const result = validateParams("create_pull_request", { draft: false, title: "Ship it" })
    assert.equal(result.valid, false)
    assert.equal(result.violations.length, 1)
    assert.ok(result.violations[0].includes("draft"))
    assert.ok(result.violations[0].includes("true"))
  })

  await test("create_pull_request with draft missing fails", () => {
    const result = validateParams("create_pull_request", { title: "No draft field" })
    assert.equal(result.valid, false)
    assert.equal(result.violations.length, 1)
    assert.ok(result.violations[0].includes("draft"))
  })

  // push_files: branch pattern constraint
  await test("push_files with finn/ branch passes", () => {
    const result = validateParams("push_files", { branch: "finn/my-feature" })
    assert.equal(result.valid, true)
    assert.equal(result.violations.length, 0)
  })

  await test("push_files with feature/ branch passes", () => {
    const result = validateParams("push_files", { branch: "feature/cool-thing" })
    assert.equal(result.valid, true)
  })

  await test("push_files with fix/ branch passes", () => {
    const result = validateParams("push_files", { branch: "fix/bug-123" })
    assert.equal(result.valid, true)
  })

  await test("push_files with chore/ branch passes", () => {
    const result = validateParams("push_files", { branch: "chore/cleanup" })
    assert.equal(result.valid, true)
  })

  await test("push_files with main branch fails", () => {
    const result = validateParams("push_files", { branch: "main" })
    assert.equal(result.valid, false)
    assert.equal(result.violations.length, 1)
    assert.ok(result.violations[0].includes("branch"))
    assert.ok(result.violations[0].includes("main"))
  })

  await test("push_files with arbitrary branch fails", () => {
    const result = validateParams("push_files", { branch: "release/v1.0" })
    assert.equal(result.valid, false)
    assert.ok(result.violations[0].includes("branch"))
  })

  await test("push_files with non-string branch fails", () => {
    const result = validateParams("push_files", { branch: 42 })
    assert.equal(result.valid, false)
    assert.ok(result.violations[0].includes("string"))
  })

  // create_or_update_file: same branch pattern constraint
  await test("create_or_update_file with finn/ branch passes", () => {
    const result = validateParams("create_or_update_file", { branch: "finn/docs-update" })
    assert.equal(result.valid, true)
  })

  await test("create_or_update_file with main branch fails", () => {
    const result = validateParams("create_or_update_file", { branch: "main" })
    assert.equal(result.valid, false)
  })

  // create_branch: branch pattern constraint (M-7 security fix)
  await test("create_branch with finn/ branch passes", () => {
    const result = validateParams("create_branch", { branch: "finn/new-feature" })
    assert.equal(result.valid, true)
  })

  await test("create_branch with main branch fails", () => {
    const result = validateParams("create_branch", { branch: "main" })
    assert.equal(result.valid, false)
    assert.ok(result.violations[0].includes("branch"))
  })

  // Tools without constraints
  await test("tool without constraints always passes", () => {
    const result = validateParams("get_pull_request", { any: "params", here: 123 })
    assert.equal(result.valid, true)
    assert.equal(result.violations.length, 0)
  })

  await test("unknown tool passes validation (no constraints to check)", () => {
    const result = validateParams("nonexistent_tool", { whatever: true })
    assert.equal(result.valid, true)
    assert.equal(result.violations.length, 0)
  })

  console.log("\nDone.")
}

main()
