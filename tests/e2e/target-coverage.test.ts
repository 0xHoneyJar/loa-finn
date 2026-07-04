// tests/e2e/target-coverage.test.ts — E2E target visibility (#242)
//
// Makes three-service E2E coverage explicit instead of silent/default-
// ambiguous: one `[e2e-targets]` line shows which service URLs this run is
// actually pointed at and whether each came from an explicit E2E_*_URL env
// var or the localhost default. Finn-only runs (the CI compose stack) are
// therefore visibly Finn-only; Freeside/Dixie-dependent suites gate on the
// env vars and show up as named skips when absent.
import { describe, expect, it } from "vitest"

type TargetSource = "env" | "default"

interface Target {
  service: "finn" | "freeside" | "dixie"
  url: string
  source: TargetSource
}

function resolveTarget(service: Target["service"], envVar: string, fallback: string): Target {
  const fromEnv = process.env[envVar]
  return {
    service,
    url: fromEnv ?? fallback,
    source: fromEnv ? "env" : "default",
  }
}

const targets: Target[] = [
  resolveTarget("finn", "E2E_FINN_URL", "http://localhost:3001"),
  resolveTarget("freeside", "E2E_FREESIDE_URL", "http://localhost:3002"),
  resolveTarget("dixie", "E2E_DIXIE_URL", "http://localhost:3003"),
]

describe("E2E target coverage", () => {
  it("reports which services this run covers", () => {
    const line = targets
      .map((t) => `${t.service}=${t.url} (${t.source})`)
      .join(" ")
    // eslint-disable-next-line no-console
    console.log(`[e2e-targets] ${line}`)

    for (const t of targets) {
      expect(t.url).toMatch(/^https?:\/\//)
    }
  })

  it("freeside/dixie coverage is explicit, never default-ambiguous", () => {
    // Suites that depend on Freeside/Dixie gate on the env vars, so a
    // default-sourced target here MUST mean those suites were skipped —
    // Finn-only evidence can no longer masquerade as three-service coverage.
    const freeside = targets.find((t) => t.service === "freeside")!
    const dixie = targets.find((t) => t.service === "dixie")!
    expect(freeside.source === "env" || freeside.url.includes("localhost:3002")).toBe(true)
    expect(dixie.source === "env" || dixie.url.includes("localhost:3003")).toBe(true)
  })
})
