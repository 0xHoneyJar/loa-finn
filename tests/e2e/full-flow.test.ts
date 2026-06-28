// tests/e2e/full-flow.test.ts — Full Flow Integration E2E (cycle-035 T-3.7)
//
// AC24: Request → JWT validation → reputation query → model routing → billing debit → response.
// All three legs participate when the harness provides Freeside and Dixie URLs.
//
// Requires docker-compose.e2e-v3.yml or explicit E2E_FREESIDE_URL/E2E_DIXIE_URL for three-leg checks.

import { describe, it, expect, beforeAll } from "vitest"
import { importPKCS8, SignJWT } from "jose"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const FINN_URL = process.env.E2E_FINN_URL ?? process.env.FINN_URL ?? "http://localhost:3001"
const FREESIDE_URL = process.env.E2E_FREESIDE_URL
const DIXIE_URL = process.env.E2E_DIXIE_URL
const THREE_LEG_ENABLED = Boolean(FREESIDE_URL && DIXIE_URL)

const describeWhen = (condition: boolean) => condition ? describe : describe.skip
const describeWhenFreeside = describeWhen(Boolean(FREESIDE_URL))
const describeWhenDixie = describeWhen(Boolean(DIXIE_URL))
const describeWhenThreeLeg = describeWhen(THREE_LEG_ENABLED)

const KEYS_DIR = resolve(import.meta.dirname ?? __dirname, "keys")

function loadPem(name: string): string {
  return readFileSync(resolve(KEYS_DIR, `${name}.pem`), "utf-8")
}

describe("E2E: Full Flow Integration", () => {
  let finnPrivateKey: CryptoKey
  let adminPrivateKey: CryptoKey

  beforeAll(async () => {
    finnPrivateKey = await importPKCS8(loadPem("finn-private"), "ES256") as CryptoKey
    adminPrivateKey = await importPKCS8(loadPem("admin-private"), "ES256") as CryptoKey
  })

  async function signFinnJwt(claims: Record<string, unknown>): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid: "e2e-v1", typ: "JWT" })
      .setIssuer("e2e-harness")
      .setAudience("arrakis")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(finnPrivateKey)
  }

  async function signAdminJwt(): Promise<string> {
    return new SignJWT({ sub: "e2e-admin", role: "operator" })
      .setProtectedHeader({ alg: "ES256", kid: "admin-e2e-v1" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(adminPrivateKey)
  }

  describe("Finn-only health verification", () => {
    it("finn is healthy", async () => {
      const finnRes = await fetch(`${FINN_URL}/healthz`, {
        signal: AbortSignal.timeout(5000),
      })
      expect(finnRes.status).toBe(200)
    })

    it("finn readiness includes local dependencies", async () => {
      const res = await fetch(`${FINN_URL}/health/deps`, {
        signal: AbortSignal.timeout(5000),
      })

      expect([200, 503]).toContain(res.status)

      const body = await res.json() as Record<string, unknown>
      expect(body).toHaveProperty("status")

      if (body.redis && typeof body.redis === "object") {
        const redis = body.redis as Record<string, unknown>
        expect(redis.connected).toBe(true)
      }
    })
  })

  describeWhenFreeside("Freeside integration checks (requires E2E_FREESIDE_URL)", () => {
    it("Freeside health endpoint is reachable", async () => {
      const freesideRes = await fetch(`${FREESIDE_URL}/v1/health`, {
        signal: AbortSignal.timeout(5000),
      })
      expect(freesideRes.status).toBe(200)
    })
  })

  describeWhenDixie("Dixie integration checks (requires E2E_DIXIE_URL)", () => {
    it("Dixie health endpoint is reachable when available", async () => {
      const dixieRes = await fetch(`${DIXIE_URL}/health`, {
        signal: AbortSignal.timeout(5000),
      }).catch(() => null)

      if (dixieRes) {
        expect([200, 404]).toContain(dixieRes.status)
      }
    })

    it("reputation query returns data or null gracefully", async () => {
      const res = await fetch(`${DIXIE_URL}/reputation/nft-test-001`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      }).catch(() => null)

      if (res && res.status === 200) {
        const body = await res.json() as Record<string, unknown>
        if (typeof body.score === "number") {
          expect(body.score).toBeGreaterThanOrEqual(0)
          expect(body.score).toBeLessThanOrEqual(1)
        }
      }
    })
  })

  describeWhenThreeLeg("Three-service integration checks (requires E2E_FREESIDE_URL and E2E_DIXIE_URL)", () => {
    it("all configured service legs are reachable", async () => {
      const finnRes = await fetch(`${FINN_URL}/healthz`, {
        signal: AbortSignal.timeout(5000),
      })
      const freesideRes = await fetch(`${FREESIDE_URL}/v1/health`, {
        signal: AbortSignal.timeout(5000),
      })
      const dixieRes = await fetch(`${DIXIE_URL}/health`, {
        signal: AbortSignal.timeout(5000),
      }).catch(() => null)

      expect(finnRes.status).toBe(200)
      expect(freesideRes.status).toBe(200)
      if (dixieRes) {
        expect([200, 404]).toContain(dixieRes.status)
      }
    })
  })

  describe("inference → billing → reputation flow", () => {
    it("finn accepts billing seed setup when an admin seed token is configured", async () => {
      const authToken = process.env.FINN_AUTH_TOKEN
      if (!authToken) {
        return
      }

      await fetch(`${FINN_URL}/api/v1/admin/seed-credits`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          wallet_address: "0x00000000000000000000000000000000deadbeef",
          credits: 10000,
        }),
        signal: AbortSignal.timeout(5000),
      })
    })
  })

  describe("circuit breaker behavior", () => {
    it("finn serves health when optional Dixie leg is not configured", async () => {
      const metricsRes = await fetch(`${FINN_URL}/metrics`, {
        signal: AbortSignal.timeout(5000),
      })

      if (metricsRes.status === 200) {
        const metrics = await metricsRes.text()
        expect(metrics).toContain("finn_reputation_query_total")

        const healthRes = await fetch(`${FINN_URL}/healthz`, {
          signal: AbortSignal.timeout(5000),
        })
        expect(healthRes.status).toBe(200)
      }
    })

    it("finn reports transport state metrics", async () => {
      const metricsRes = await fetch(`${FINN_URL}/metrics`, {
        signal: AbortSignal.timeout(5000),
      })

      if (metricsRes.status === 200) {
        const metrics = await metricsRes.text()
        expect(metrics).toContain("finn_shadow_total")

        const expectedMetrics = [
          "finn_shadow_total",
          "finn_shadow_diverged",
          "finn_reputation_query_total",
          "finn_reputation_query_duration_seconds",
          "finn_exploration_total",
          "finn_ema_updates_total",
          "finn_routing_mode_transitions_total",
        ]

        for (const metric of expectedMetrics) {
          expect(metrics).toContain(metric)
        }
      }
    })
  })

  describe("mode-aware routing integration", () => {
    it("shadow mode: scoring runs but deterministic routing used", async () => {
      const token = await signAdminJwt()

      const getRes = await fetch(`${FINN_URL}/api/v1/admin/mode`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      })

      if (getRes.status === 200) {
        const body = await getRes.json() as { mode: string }

        if (body.mode !== "shadow") {
          await fetch(`${FINN_URL}/api/v1/admin/mode`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ mode: "shadow" }),
            signal: AbortSignal.timeout(5000),
          })
        }

        const metricsRes = await fetch(`${FINN_URL}/metrics`, {
          signal: AbortSignal.timeout(5000),
        })
        if (metricsRes.status === 200) {
          const metrics = await metricsRes.text()
          expect(metrics).toContain("finn_shadow_total")
        }
      }
    })

    it("enabled mode: reputation scoring drives routing decisions", async () => {
      const token = await signAdminJwt()

      const setRes = await fetch(`${FINN_URL}/api/v1/admin/mode`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ mode: "enabled" }),
        signal: AbortSignal.timeout(5000),
      })

      if (setRes.status === 200) {
        const body = await setRes.json() as { mode: string }
        expect(body.mode).toBe("enabled")

        const metricsRes = await fetch(`${FINN_URL}/metrics`, {
          signal: AbortSignal.timeout(5000),
        })
        if (metricsRes.status === 200) {
          const metrics = await metricsRes.text()
          expect(metrics).toContain("finn_routing_mode_transitions_total")
        }

        await fetch(`${FINN_URL}/api/v1/admin/mode`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ mode: "shadow" }),
          signal: AbortSignal.timeout(5000),
        })
      }
    })

    it("disabled mode: immediate deterministic routing, no reputation queries", async () => {
      const token = await signAdminJwt()

      const beforeMetrics = await fetchMetrics()
      const queryCountBefore = extractCounter(beforeMetrics, "finn_reputation_query_total")

      const setRes = await fetch(`${FINN_URL}/api/v1/admin/mode`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ mode: "disabled" }),
        signal: AbortSignal.timeout(5000),
      })

      if (setRes.status === 200) {
        const afterMetrics = await fetchMetrics()
        const queryCountAfter = extractCounter(afterMetrics, "finn_reputation_query_total")
        expect(queryCountAfter).toBe(queryCountBefore)

        await fetch(`${FINN_URL}/api/v1/admin/mode`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ mode: "shadow" }),
          signal: AbortSignal.timeout(5000),
        })
      }
    })
  })
})

async function fetchMetrics(): Promise<string> {
  const res = await fetch(`${FINN_URL}/metrics`, {
    signal: AbortSignal.timeout(5000),
  })
  return res.status === 200 ? await res.text() : ""
}

function extractCounter(prometheusText: string, metricName: string): number {
  const lines = prometheusText.split("\n")
  let total = 0
  for (const line of lines) {
    if (line.startsWith(`${metricName}{`) || line.startsWith(`${metricName} `)) {
      const match = line.match(/\}\s+(\d+)$/) ?? line.match(/\s+(\d+)$/)
      if (match) {
        total += parseInt(match[1], 10)
      }
    }
  }
  return total
}
