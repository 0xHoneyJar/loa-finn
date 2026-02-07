// tests/finn/alert-service.test.ts — Alert Service unit tests (T-1.8)

import assert from "node:assert/strict"
import {
  AlertService,
  DEFAULT_ROUTING,
} from "../../src/safety/alert-service.js"
import type {
  AlertServiceConfig,
  AlertSeverity,
  AlertChannel,
  AlertContext,
} from "../../src/safety/alert-service.js"

// ── Helpers ──────────────────────────────────────────────────

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

/** Tracks fetch calls for assertions. */
interface FetchCall {
  url: string
  init: RequestInit
  body: Record<string, unknown>
}

/** Stub fetch that records calls and returns a configurable response. */
function createStubFetch(
  statusCode = 201,
  responseBody = "{}",
): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const stubFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const bodyStr = typeof init?.body === "string" ? init.body : "{}"
    calls.push({ url, init: init ?? {}, body: JSON.parse(bodyStr) })
    return new Response(responseBody, { status: statusCode })
  }
  return { fetch: stubFetch as typeof globalThis.fetch, calls }
}

/** Minimal config with all channels configured. */
function makeConfig(overrides?: Partial<AlertServiceConfig>): AlertServiceConfig {
  return {
    channels: {
      github_issue: {
        owner: "test-org",
        repo: "test-repo",
        token: "ghp_test_token",
        onCallTeam: "oncall",
        ...overrides?.channels?.github_issue,
      },
      webhook: {
        url: "https://hooks.example.com/alert",
        ...overrides?.channels?.webhook,
      },
    },
    routing: overrides?.routing ?? { ...DEFAULT_ROUTING },
    deduplicationWindowMs: overrides?.deduplicationWindowMs,
  }
}

// ── Tests ────────────────────────────────────────────────────

async function main() {
  console.log("Alert Service Tests (T-1.8)")
  console.log("===========================")

  // ── 1. Severity Routing ─────────────────────────────────

  console.log("\n--- Severity Routing ---")

  await test("critical routes to github_issue, webhook, and log", async () => {
    const { fetch, calls } = createStubFetch()
    const logs: string[] = []
    const origError = console.error
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")) }

    const svc = new AlertService(makeConfig(), { fetch })
    const dispatched = await svc.fire("critical", "threshold_exceeded", { message: "CPU > 95%" })

    console.error = origError
    assert.equal(dispatched, true)
    // Two fetch calls: one for github_issue, one for webhook
    assert.equal(calls.length, 2)
    const ghCall = calls.find((c) => c.url.includes("github.com"))
    const whCall = calls.find((c) => c.url.includes("hooks.example.com"))
    assert.ok(ghCall, "expected a GitHub API call")
    assert.ok(whCall, "expected a webhook call")
    // Log channel should have fired (captured in logs)
    assert.ok(logs.some((l) => l.includes("Alert:critical")), "expected log output")
  })

  await test("error routes to github_issue and log (no webhook)", async () => {
    const { fetch, calls } = createStubFetch()
    const logs: string[] = []
    const origError = console.error
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")) }

    const svc = new AlertService(makeConfig(), { fetch })
    const dispatched = await svc.fire("error", "run_failed", { message: "exit code 1" })

    console.error = origError
    assert.equal(dispatched, true)
    // Only github_issue fetch call (no webhook for error)
    assert.equal(calls.length, 1)
    assert.ok(calls[0].url.includes("github.com"))
    assert.ok(logs.some((l) => l.includes("Alert:error")))
  })

  await test("warning routes to webhook and log (no github_issue)", async () => {
    const { fetch, calls } = createStubFetch()
    const logs: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(" ")) }

    const svc = new AlertService(makeConfig(), { fetch })
    const dispatched = await svc.fire("warning", "slow_run", { message: "took 5 min" })

    console.warn = origWarn
    assert.equal(dispatched, true)
    assert.equal(calls.length, 1)
    assert.ok(calls[0].url.includes("hooks.example.com"))
    assert.ok(logs.some((l) => l.includes("Alert:warning")))
  })

  await test("info routes to log only (no fetch calls)", async () => {
    const { fetch, calls } = createStubFetch()
    const logs: string[] = []
    const origInfo = console.info
    console.info = (...args: unknown[]) => { logs.push(args.map(String).join(" ")) }

    const svc = new AlertService(makeConfig(), { fetch })
    const dispatched = await svc.fire("info", "run_started", { message: "starting job" })

    console.info = origInfo
    assert.equal(dispatched, true)
    assert.equal(calls.length, 0, "info should not trigger fetch")
    assert.ok(logs.some((l) => l.includes("Alert:info")))
  })

  // ── 2. Custom Routing ──────────────────────────────────

  console.log("\n--- Custom Routing ---")

  await test("custom routing overrides default", async () => {
    const { fetch, calls } = createStubFetch()
    const customRouting: Record<AlertSeverity, AlertChannel[]> = {
      critical: ["log"],
      error: ["log"],
      warning: ["log"],
      info: ["log"],
    }

    const origError = console.error
    console.error = () => {}
    const svc = new AlertService(makeConfig({ routing: customRouting }), { fetch })
    await svc.fire("critical", "test", { message: "test" })
    console.error = origError

    assert.equal(calls.length, 0, "custom routing with log-only should not fetch")
  })

  await test("DEFAULT_ROUTING export has expected shape", () => {
    assert.deepEqual(DEFAULT_ROUTING.critical, ["github_issue", "webhook", "log"])
    assert.deepEqual(DEFAULT_ROUTING.error, ["github_issue", "log"])
    assert.deepEqual(DEFAULT_ROUTING.warning, ["webhook", "log"])
    assert.deepEqual(DEFAULT_ROUTING.info, ["log"])
  })

  // ── 3. Deduplication ───────────────────────────────────

  console.log("\n--- Deduplication ---")

  await test("duplicate alert within window is suppressed", async () => {
    const { fetch, calls } = createStubFetch()
    let now = 1_000_000

    const origError = console.error
    console.error = () => {}
    const svc = new AlertService(makeConfig(), { fetch, now: () => now })

    const ctx: AlertContext = { jobId: "job-1", message: "disk full" }
    const first = await svc.fire("critical", "disk_full", ctx)
    assert.equal(first, true)

    // Fire again 5 minutes later (within 15-min window)
    now += 5 * 60 * 1000
    const second = await svc.fire("critical", "disk_full", ctx)
    assert.equal(second, false, "second fire within window should be suppressed")

    // Only the first fire's fetch calls should exist (2: github + webhook)
    assert.equal(calls.length, 2)
    console.error = origError
  })

  await test("alert after dedup window expires is dispatched", async () => {
    const { fetch, calls } = createStubFetch()
    let now = 1_000_000

    const origError = console.error
    console.error = () => {}
    const svc = new AlertService(makeConfig(), { fetch, now: () => now })

    const ctx: AlertContext = { jobId: "job-2", message: "oom" }
    await svc.fire("critical", "oom", ctx)
    assert.equal(calls.length, 2) // github + webhook

    // Advance past the 15-min window
    now += 16 * 60 * 1000
    const second = await svc.fire("critical", "oom", ctx)
    assert.equal(second, true, "should dispatch after window expires")
    assert.equal(calls.length, 4) // 2 more calls
    console.error = origError
  })

  await test("different triggerTypes are not deduplicated", async () => {
    const { fetch, calls } = createStubFetch()

    const origError = console.error
    console.error = () => {}
    const svc = new AlertService(makeConfig(), { fetch })

    await svc.fire("error", "type_a", { message: "a" })
    const second = await svc.fire("error", "type_b", { message: "b" })
    assert.equal(second, true, "different trigger types should not dedup")
    // Each error fires 1 fetch (github_issue only for error), so 2 total
    assert.equal(calls.length, 2)
    console.error = origError
  })

  await test("different jobIds are not deduplicated", async () => {
    const { fetch, calls } = createStubFetch()

    const origError = console.error
    console.error = () => {}
    const svc = new AlertService(makeConfig(), { fetch })

    await svc.fire("error", "fail", { jobId: "j1", message: "a" })
    const second = await svc.fire("error", "fail", { jobId: "j2", message: "b" })
    assert.equal(second, true, "different jobIds should not dedup")
    assert.equal(calls.length, 2)
    console.error = origError
  })

  await test("different severity is not deduplicated", async () => {
    const { fetch } = createStubFetch()
    let now = 1_000_000

    const origError = console.error
    console.error = () => {}
    const svc = new AlertService(
      makeConfig({ deduplicationWindowMs: 60_000 }),
      { fetch, now: () => now },
    )

    const ctx: AlertContext = { message: "Severity test", jobId: "job-1" }
    const first = await svc.fire("error", "sev:trigger", ctx)
    assert.equal(first, true)

    now += 100
    const second = await svc.fire("critical", "sev:trigger", ctx)
    assert.equal(second, true, "different severity = different dedup key")
    console.error = origError
  })

  await test("custom dedup window is respected", async () => {
    const { fetch } = createStubFetch()
    let now = 1_000_000

    const origError = console.error
    console.error = () => {}
    // 1-second dedup window
    const svc = new AlertService(
      makeConfig({ deduplicationWindowMs: 1000 }),
      { fetch, now: () => now },
    )

    await svc.fire("error", "fast", { jobId: "j", message: "a" })
    now += 1001
    const second = await svc.fire("error", "fast", { jobId: "j", message: "b" })
    assert.equal(second, true, "should dispatch after short custom window")
    console.error = origError
  })

  await test("dedup with no jobId uses underscore placeholder", async () => {
    const { fetch } = createStubFetch()
    let now = 1_000_000

    const origError = console.error
    console.error = () => {}
    const svc = new AlertService(makeConfig(), { fetch, now: () => now })

    await svc.fire("error", "no_job", { message: "a" })
    now += 1000
    const second = await svc.fire("error", "no_job", { message: "b" })
    assert.equal(second, false, "same trigger without jobId should dedup")
    console.error = origError
  })

  // ── 4. GitHub Issue Channel ────────────────────────────

  console.log("\n--- GitHub Issue Channel ---")

  await test("GitHub issue has correct title, body, and labels", async () => {
    const { fetch, calls } = createStubFetch()
    const routing: Record<AlertSeverity, AlertChannel[]> = {
      critical: ["github_issue"],
      error: ["github_issue"],
      warning: [],
      info: [],
    }
    const svc = new AlertService(makeConfig({ routing }), { fetch })
    await svc.fire("critical", "threshold", {
      jobId: "job-42",
      runId: "run-7",
      templateId: "tpl-3",
      message: "Memory exceeded",
      details: { usageMb: 4096 },
    })

    assert.equal(calls.length, 1)
    const call = calls[0]
    assert.ok(call.url.includes("/repos/test-org/test-repo/issues"))
    assert.ok((call.init.headers as Record<string, string>)["Authorization"]?.includes("ghp_test_token"))

    const body = call.body as { title: string; body: string; labels: string[] }
    assert.ok(body.title.includes("[CRITICAL]"))
    assert.ok(body.title.includes("threshold"))
    assert.ok(body.title.includes("Memory exceeded"))
    assert.ok(body.body.includes("job-42"))
    assert.ok(body.body.includes("run-7"))
    assert.ok(body.body.includes("tpl-3"))
    assert.ok(body.body.includes("4096"))
    assert.ok(body.labels.includes("alert:critical"))
    assert.ok(body.labels.includes("team:oncall"))
  })

  await test("GitHub issue without onCallTeam omits team label", async () => {
    const { fetch, calls } = createStubFetch()
    const config = makeConfig({
      routing: { critical: ["github_issue"], error: [], warning: [], info: [] },
    })
    config.channels.github_issue = {
      owner: "org",
      repo: "repo",
      token: "tok",
    }
    const svc = new AlertService(config, { fetch })
    await svc.fire("critical", "test", { message: "test" })

    const body = calls[0].body as { labels: string[] }
    assert.equal(body.labels.length, 1)
    assert.equal(body.labels[0], "alert:critical")
  })

  await test("missing github_issue config skips channel silently", async () => {
    const { fetch, calls } = createStubFetch()
    const config: AlertServiceConfig = {
      channels: {},
      routing: { critical: ["github_issue"], error: [], warning: [], info: [] },
    }
    const svc = new AlertService(config, { fetch })
    const result = await svc.fire("critical", "test", { message: "no config" })
    assert.equal(result, true)
    assert.equal(calls.length, 0, "no fetch when github config missing")
  })

  await test("GitHub issue includes details block when provided", async () => {
    const { fetch, calls } = createStubFetch()
    const routing: Record<AlertSeverity, AlertChannel[]> = {
      critical: [],
      error: ["github_issue"],
      warning: [],
      info: [],
    }
    const svc = new AlertService(makeConfig({ routing }), { fetch })

    await svc.fire("error", "details:test", {
      message: "With details",
      details: { foo: "bar", count: 42 },
    })

    const ghCall = calls.find((c) => c.url.includes("github.com"))
    assert.ok(ghCall)
    const body = ghCall.body as { body: string }
    assert.ok(body.body.includes("Details"))
    assert.ok(body.body.includes('"foo"'))
  })

  // ── 5. Webhook Channel ────────────────────────────────

  console.log("\n--- Webhook Channel ---")

  await test("webhook sends structured JSON payload", async () => {
    const { fetch, calls } = createStubFetch()
    const now = 1_700_000_000_000
    const routing: Record<AlertSeverity, AlertChannel[]> = {
      critical: ["webhook"],
      error: [],
      warning: [],
      info: [],
    }
    const svc = new AlertService(makeConfig({ routing }), { fetch, now: () => now })
    await svc.fire("critical", "overload", {
      jobId: "j1",
      runId: "r1",
      message: "CPU overload",
      details: { cpu: 99 },
    })

    assert.equal(calls.length, 1)
    const call = calls[0]
    assert.equal(call.url, "https://hooks.example.com/alert")
    assert.equal((call.init.headers as Record<string, string>)["Content-Type"], "application/json")

    const payload = call.body as {
      severity: string
      triggerType: string
      timestamp: string
      context: Record<string, unknown>
    }
    assert.equal(payload.severity, "critical")
    assert.equal(payload.triggerType, "overload")
    assert.ok(payload.timestamp)
    assert.equal(payload.context.jobId, "j1")
    assert.equal(payload.context.runId, "r1")
    assert.equal(payload.context.message, "CPU overload")
    assert.deepEqual(payload.context.details, { cpu: 99 })
  })

  await test("missing webhook config skips channel silently", async () => {
    const { fetch, calls } = createStubFetch()
    const config: AlertServiceConfig = {
      channels: {},
      routing: { critical: ["webhook"], error: [], warning: [], info: [] },
    }
    const svc = new AlertService(config, { fetch })
    const result = await svc.fire("critical", "test", { message: "no webhook" })
    assert.equal(result, true)
    assert.equal(calls.length, 0)
  })

  // ── 6. Error Resilience ────────────────────────────────

  console.log("\n--- Error Resilience ---")

  await test("fire does not throw when GitHub API returns error", async () => {
    const { fetch } = createStubFetch(500, "Internal Server Error")
    const origError = console.error
    const errors: string[] = []
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")) }

    const svc = new AlertService(makeConfig(), { fetch })
    const result = await svc.fire("critical", "api_err", { message: "test" })

    console.error = origError
    assert.equal(result, true, "fire should still return true (dispatched, not all succeeded)")
    assert.ok(errors.some((e) => e.includes("channel") && e.includes("failed")))
  })

  await test("fire does not throw when fetch itself throws", async () => {
    const throwingFetch = async () => {
      throw new Error("network unreachable")
    }
    const origError = console.error
    const errors: string[] = []
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")) }

    const svc = new AlertService(makeConfig(), { fetch: throwingFetch as typeof globalThis.fetch })
    const result = await svc.fire("critical", "net_err", { message: "unreachable" })

    console.error = origError
    assert.equal(result, true)
    assert.ok(errors.some((e) => e.includes("network unreachable")))
  })

  await test("fire does not throw when webhook returns 4xx", async () => {
    const { fetch } = createStubFetch(400, "Bad Request")
    const origError = console.error
    const origWarn = console.warn
    const captured: string[] = []
    console.error = (...args: unknown[]) => { captured.push(args.map(String).join(" ")) }
    console.warn = (...args: unknown[]) => { captured.push(args.map(String).join(" ")) }

    const svc = new AlertService(makeConfig(), { fetch })
    const result = await svc.fire("warning", "bad_req", { message: "test" })

    console.error = origError
    console.warn = origWarn
    assert.equal(result, true)
  })

  await test("fire handles missing channel config gracefully", async () => {
    const { fetch, calls } = createStubFetch()
    const svc = new AlertService(
      { channels: {}, routing: DEFAULT_ROUTING },
      { fetch },
    )

    // Silence expected console output
    const origError = console.error
    console.error = () => {}
    const result = await svc.fire("critical", "no-config:test", { message: "No channels" })
    console.error = origError

    assert.equal(result, true)
    assert.equal(calls.length, 0, "no fetch calls when channels unconfigured")
  })

  // ── 7. Log Channel ────────────────────────────────────

  console.log("\n--- Log Channel ---")

  await test("log channel uses console.error for critical", async () => {
    const logs: string[] = []
    const origError = console.error
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")) }

    const routing: Record<AlertSeverity, AlertChannel[]> = {
      critical: ["log"],
      error: [],
      warning: [],
      info: [],
    }
    const svc = new AlertService(makeConfig({ routing }), { fetch: createStubFetch().fetch })
    await svc.fire("critical", "crit_log", { message: "critical msg" })

    console.error = origError
    assert.ok(logs.some((l) => l.includes("Alert:critical") && l.includes("crit_log")))
  })

  await test("log channel uses console.error for error", async () => {
    const logs: string[] = []
    const origError = console.error
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")) }

    const routing: Record<AlertSeverity, AlertChannel[]> = {
      critical: [],
      error: ["log"],
      warning: [],
      info: [],
    }
    const svc = new AlertService(makeConfig({ routing }), { fetch: createStubFetch().fetch })
    await svc.fire("error", "err_log", { message: "error msg" })

    console.error = origError
    assert.ok(logs.some((l) => l.includes("Alert:error") && l.includes("err_log")))
  })

  await test("log channel uses console.warn for warning", async () => {
    const logs: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(" ")) }

    const routing: Record<AlertSeverity, AlertChannel[]> = {
      critical: [],
      error: [],
      warning: ["log"],
      info: [],
    }
    const svc = new AlertService(makeConfig({ routing }), { fetch: createStubFetch().fetch })
    await svc.fire("warning", "warn_log", { message: "warning msg" })

    console.warn = origWarn
    assert.ok(logs.some((l) => l.includes("Alert:warning") && l.includes("warn_log")))
  })

  await test("log channel uses console.info for info", async () => {
    const logs: string[] = []
    const origInfo = console.info
    console.info = (...args: unknown[]) => { logs.push(args.map(String).join(" ")) }

    const routing: Record<AlertSeverity, AlertChannel[]> = {
      critical: [],
      error: [],
      warning: [],
      info: ["log"],
    }
    const svc = new AlertService(makeConfig({ routing }), { fetch: createStubFetch().fetch })
    await svc.fire("info", "info_log", { message: "info msg" })

    console.info = origInfo
    assert.ok(logs.some((l) => l.includes("Alert:info") && l.includes("info_log")))
  })

  // ── 8. Edge Cases ─────────────────────────────────────

  console.log("\n--- Edge Cases ---")

  await test("context without optional fields works", async () => {
    const { fetch, calls } = createStubFetch()
    const routing: Record<AlertSeverity, AlertChannel[]> = {
      critical: ["github_issue", "webhook"],
      error: [],
      warning: [],
      info: [],
    }
    const svc = new AlertService(makeConfig({ routing }), { fetch })
    const result = await svc.fire("critical", "minimal", { message: "bare minimum" })
    assert.equal(result, true)
    assert.equal(calls.length, 2)

    // GitHub issue body should not contain "undefined"
    const ghBody = calls.find((c) => c.url.includes("github.com"))!.body as { body: string }
    assert.ok(!ghBody.body.includes("undefined"))

    // Webhook payload should have null for missing optional fields
    const whPayload = calls.find((c) => c.url.includes("hooks.example.com"))!.body as {
      context: { jobId: unknown; runId: unknown; templateId: unknown }
    }
    assert.equal(whPayload.context.jobId, null)
    assert.equal(whPayload.context.runId, null)
    assert.equal(whPayload.context.templateId, null)
  })

  console.log("\nDone.")
}

main()
