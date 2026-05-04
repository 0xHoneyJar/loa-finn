// src/substrate/__tests__/model-runner-layer.integration.test.ts
//
// Cycle-032 Sprint-3 Task 3.3 — THE LOAD-BEARING TEST.
//
// Verifies cross-pack Tag identity between this loader's ModelRunner Layer and
// the construct's Context.Tag("ModelRunner") declaration. This is the
// PAIR-POINT named in build doc §13 + sprint plan.
//
// What's tested:
//   1. Loader's `buildModelRunnerLayer({...})` Layer's Tag matches construct's Tag
//      (Effect's string-based Tag identity → both use "ModelRunner")
//   2. Construct's `gradeLoreEssay` (a real Effect program) resolves with the
//      Layer + receives the canned cheval response + parses to LoreEssayOutput
//   3. Error-shape compatibility: ModelRunnerError {reason, message} from this
//      module is structurally compatible with the construct's error class
//
// **Portability note**: this test imports `construct-lore-essay-grader/dist/`
// from a sibling repo at `~/Documents/GitHub/construct-lore-essay-grader/`.
// On CI / fresh checkouts, the construct must be built (run
// `pnpm install && pnpm build` in that repo) before this test runs.
// `describe.skipIf` guards the test if the build artifacts are missing.

import { describe, it, expect } from "vitest"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { buildModelRunnerLayer, ModelRunner as LoaderModelRunner, ModelRunnerError } from "../model-runner-layer.js"
import type { CompletionRequest, CompletionResult } from "../../hounfour/types.js"

// Path-resolution: the construct lives at ~/Documents/GitHub/construct-lore-essay-grader
// after a successful `pnpm build` in that repo.
const constructDistPath = join(homedir(), "Documents/GitHub/construct-lore-essay-grader/dist/index.js")
const constructAvailable = existsSync(constructDistPath)

const fileUrl = `file://${constructDistPath}`

// ── Fake cheval ─────────────────────────────────────────────────────

function cannedJsonResponse(verdict: { status: string; confidence: number }): CompletionResult {
  return {
    content: JSON.stringify({
      ...verdict,
      reasoning: "The essay specifically engages 'the labyrinth' phrase from the lore. loreFit drove the verdict.",
      dimensions: { loreFit: 0.85, voiceMatch: 0.75, specificity: 0.78 },
    }),
    thinking: null,
    tool_calls: null,
    usage: { prompt_tokens: 50, completion_tokens: 100, reasoning_tokens: 0 },
    metadata: { model: "test-model", latency_ms: 100, trace_id: "test-trace" },
  }
}

const cannedInvoker = {
  complete: async (_req: CompletionRequest) => cannedJsonResponse({ status: "APPROVED", confidence: 0.85 }),
}

// ── Tests ───────────────────────────────────────────────────────────

describe.skipIf(!constructAvailable)(
  "model-runner-layer × construct-lore-essay-grader (PAIR-POINT)",
  () => {
    it("loader's ModelRunner Layer satisfies construct's gradeLoreEssay Tag requirement", async () => {
      // Dynamic import the BUILT construct from its dist/ artifacts.
      // Using string variable to dodge static analysis that would try to resolve at compile time.
      const constructModule = (await import(fileUrl)) as {
        ModelRunner: { key: string }
        gradeLoreEssay: (
          input: unknown,
        ) => Effect.Effect<unknown, unknown, unknown>
      }

      // Tag identity assertion — both keys MUST match
      expect(constructModule.ModelRunner.key).toBe(LoaderModelRunner.key)
      expect(constructModule.ModelRunner.key).toBe("ModelRunner")

      // Build the loader's Layer with canned cheval
      const layer = buildModelRunnerLayer({
        invoker: cannedInvoker,
        modelId: "test-model",
        agentId: "test-agent",
        tenantId: "test-tenant",
      })

      // Run the construct's actual program with the loader's Layer
      const input = {
        essay: "the labyrinth coils through the codex like ink through cloth",
        rubric: {
          prompt: "describe the relationship between the labyrinth and memory",
          loreContext: "Mibera's library houses the labyrinth — a structured infinity.",
          passThreshold: 0.6,
        },
        submissionId: "submission-test",
        traceId: "trace-test",
      }

      const program = constructModule.gradeLoreEssay(input)
      const result = (await Effect.runPromise(program.pipe(Effect.provide(layer as never)))) as {
        status: string
        confidence: number
        graderConstructSlug?: string
        dimensions: { loreFit: number; voiceMatch: number; specificity: number }
      }

      // The construct should have parsed the canned LLM response into LoreEssayOutput shape
      expect(result.status).toBe("APPROVED")
      expect(result.confidence).toBe(0.85)
      expect(result.dimensions.loreFit).toBe(0.85)
      expect(result.dimensions.voiceMatch).toBe(0.75)
      expect(result.dimensions.specificity).toBe(0.78)
    })

    it("error path: cheval failure surfaces through construct as Effect failure", async () => {
      const constructModule = (await import(fileUrl)) as {
        gradeLoreEssay: (input: unknown) => Effect.Effect<unknown, unknown, unknown>
      }

      const failingLayer = buildModelRunnerLayer({
        invoker: {
          complete: async () => {
            throw new Error("simulated cheval failure")
          },
        },
        modelId: "test-model",
        agentId: "test-agent",
        tenantId: "test-tenant",
      })

      const input = {
        essay: "test essay text",
        rubric: { prompt: "test prompt" },
        submissionId: "submission-fail",
        traceId: "trace-fail",
      }

      const program = constructModule.gradeLoreEssay(input)
      const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(failingLayer as never)))

      expect(exit._tag).toBe("Failure")
      // The construct should have received the loader-emitted ModelRunnerError
      // (its grader.ts pattern-matches on ModelRunnerError._tag)
      const causeStr = JSON.stringify(exit.cause)
      expect(causeStr).toContain("ModelRunnerError")
    })

    it("ModelRunnerError shape from loader matches construct's expectations", async () => {
      // Both sides expect _tag, reason, message
      const err = new ModelRunnerError("timeout", "test message")
      expect(err._tag).toBe("ModelRunnerError")
      expect(err.reason).toBe("timeout")
      expect(err.message).toBe("test message")
      // Construct grader.ts:50-58 declares the exact same shape; runtime
      // pattern-matching on _tag === "ModelRunnerError" works regardless of
      // which class the error is an instance of.
    })
  },
)

describe.skipIf(constructAvailable)("PAIR-POINT availability", () => {
  it("WARNING: construct-lore-essay-grader not built — PAIR-POINT integration test SKIPPED", () => {
    // Show useful instructions when the construct artifacts are absent.
    const instructions = [
      "Cross-pack integration test requires the construct to be built.",
      "Run:",
      "  cd ~/Documents/GitHub/construct-lore-essay-grader",
      "  pnpm install && pnpm build",
      "Then re-run this test.",
    ].join("\n")
    console.warn(instructions)
    expect(true).toBe(true) // marker test — always passes when triggered
  })
})
