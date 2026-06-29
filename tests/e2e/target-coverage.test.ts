// tests/e2e/target-coverage.test.ts — visible three-service target coverage
//
// This intentionally does not prove Freeside/Dixie behavior by itself. It makes
// the selected service targets explicit in E2E output so Finn-only/default-target
// runs are not mistaken for externally configured three-service evidence.

import { describe, expect, it } from "vitest"

type TargetStatus = {
  service: "finn" | "freeside" | "dixie"
  envName: string
  url: string
  source: "env" | "default"
}

function resolveTarget(service: TargetStatus["service"], envName: string, fallbackUrl: string): TargetStatus {
  const configured = process.env[envName]?.trim()

  return {
    service,
    envName,
    url: configured && configured.length > 0 ? configured : fallbackUrl,
    source: configured && configured.length > 0 ? "env" : "default",
  }
}

function targetSummary(target: TargetStatus): string {
  return `${target.service}: ${target.url} (${target.envName}=${target.source})`
}

describe("E2E target coverage visibility", () => {
  it("prints whether each three-service target came from env or the local default", () => {
    const targets = [
      resolveTarget("finn", "E2E_FINN_URL", "http://localhost:3001"),
      resolveTarget("freeside", "E2E_FREESIDE_URL", "http://localhost:3002"),
      resolveTarget("dixie", "E2E_DIXIE_URL", "http://localhost:3003"),
    ]

    console.info(`[e2e-targets] ${targets.map(targetSummary).join("; ")}`)

    expect(targets.map((target) => target.service)).toEqual(["finn", "freeside", "dixie"])
    expect(targets.every((target) => target.url.length > 0)).toBe(true)
  })
})
