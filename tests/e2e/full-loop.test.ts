// tests/e2e/full-loop.test.ts — Full-Loop E2E Test (JWT -> Session -> WebSocket -> Inference -> Billing)
//
// Exercises the complete request lifecycle against running Finn services.
//
// Requires:
//   CHEVAL_MODE=mock  (deterministic inference)
//   Redis on port 6380
//   Finn on http://localhost:3001
//   ioredis installed (npm i -D ioredis)

import { describe, it, expect, beforeAll } from "vitest"
import { importPKCS8, SignJWT } from "jose"
import { WebSocket } from "ws"
import { randomUUID, createHash } from "node:crypto"
import Redis from "ioredis"
import { loadPrivateKeyPem } from "./helpers.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FINN_URL = process.env.FINN_URL ?? "http://localhost:3001"
const REDIS_PORT = Number(process.env.E2E_REDIS_PORT ?? 6380)
const TENANT_ID = `e2e-tenant-${randomUUID()}`

// ---------------------------------------------------------------------------
// Key Material — reads the SAME key finn uses (from .env.e2e)
// ---------------------------------------------------------------------------

let privateKey: Awaited<ReturnType<typeof importPKCS8>>

beforeAll(async () => {
  const pem = loadPrivateKeyPem()
  privateKey = await importPKCS8(pem, "ES256")
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute SHA-256 hex digest of a request body, formatted as `sha256:<hex>`. */
function reqHash(body: string): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`
}

/** Mint a signed ES256 JWT with the standard E2E claims. */
async function mintJWT(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const jti = randomUUID()

  const claims: Record<string, unknown> = {
    iss: "e2e-harness",
    aud: "loa-finn",
    tenant_id: TENANT_ID,
    tier: "pro",
    req_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    jti,
    exp: now + 60,
    ...overrides,
  }

  return new SignJWT(claims as Record<string, unknown>)
    .setProtectedHeader({ alg: "ES256", kid: "e2e-v1" })
    .sign(privateKey)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: Full Loop — JWT -> Session -> WebSocket -> Inference -> Billing", () => {
  it("full loop: JWT -> session -> WebSocket -> inference -> billing", async () => {
    // -----------------------------------------------------------------------
    // 1. Mint JWT
    // -----------------------------------------------------------------------
    const sessionBody = JSON.stringify({ tenant_id: TENANT_ID })
    const token = await mintJWT({ req_hash: reqHash(sessionBody) })
    expect(token).toBeTruthy()

    // -----------------------------------------------------------------------
    // 2. Create Session
    // -----------------------------------------------------------------------
    const sessionRes = await fetch(`${FINN_URL}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: sessionBody,
    })

    expect(sessionRes.status).toBe(201)
    const sessionData = (await sessionRes.json()) as { sessionId: string }
    expect(sessionData).toHaveProperty("sessionId")
    expect(typeof sessionData.sessionId).toBe("string")

    const { sessionId } = sessionData

    // -----------------------------------------------------------------------
    // 3. Connect WebSocket
    // -----------------------------------------------------------------------
    const baseUrl = new URL(FINN_URL)
    const wsTarget = new URL(`/ws/${sessionId}`, baseUrl)
    wsTarget.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:"
    wsTarget.searchParams.set("token", token)

    const messages: Array<{ type: string; [key: string]: unknown }> = []

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsTarget.toString())
      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error("WebSocket timed out after 25 s"))
      }, 25_000)

      ws.on("open", () => {
        // -----------------------------------------------------------------
        // 4. Send Prompt
        // -----------------------------------------------------------------
        ws.send(JSON.stringify({ type: "prompt", text: "Hello" }))
      })

      ws.on("message", (raw: Buffer) => {
        const msg = JSON.parse(raw.toString())
        messages.push(msg)

        // -----------------------------------------------------------------
        // 5. Collect until turn_end
        // -----------------------------------------------------------------
        if (msg.type === "turn_end") {
          clearTimeout(timeout)
          ws.close()
          resolve()
        }
      })

      ws.on("error", (err: Error) => {
        clearTimeout(timeout)
        reject(err)
      })
    })

    // -----------------------------------------------------------------------
    // 6. Assert inference produced at least one text_delta
    // -----------------------------------------------------------------------
    const textDeltas = messages.filter((m) => m.type === "text_delta")
    expect(textDeltas.length).toBeGreaterThanOrEqual(1)

    // -----------------------------------------------------------------------
    // 7. Assert billing: budget key exists in Redis
    // -----------------------------------------------------------------------
    const redis = new Redis({ port: REDIS_PORT, lazyConnect: true })
    try {
      await redis.connect()

      // Scan for budget:<tenant> keys
      const keys = await redis.keys(`budget:${TENANT_ID}*`)
      expect(keys.length).toBeGreaterThanOrEqual(1)
    } finally {
      await redis.quit()
    }
  }, 30_000)
})
