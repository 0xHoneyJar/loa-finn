// tests/e2e/helpers.ts — Shared E2E test utilities
//
// Extracted from duplicated code across E2E test files.

import { readFileSync, existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Load the ES256 private key PEM for E2E tests.
 *
 * Resolution order:
 * 1. E2E_ES256_PRIVATE_KEY env var (base64-encoded)
 * 2. .env.e2e file (searches multiple candidate paths)
 */
export function loadPrivateKeyPem(): string {
  const fromEnv = process.env.E2E_ES256_PRIVATE_KEY
  if (fromEnv) return Buffer.from(fromEnv, "base64").toString("utf-8")

  const __filename = fileURLToPath(import.meta.url)
  const __dir = dirname(__filename)
  const candidates = [
    resolve(__dir, ".env.e2e"),
    resolve(process.cwd(), "tests/e2e/.env.e2e"),
    resolve(process.cwd(), ".env.e2e"),
  ]
  const envPath = candidates.find((p) => existsSync(p))
  if (!envPath) throw new Error("Unable to locate .env.e2e for FINN_S2S_PRIVATE_KEY")

  const content = readFileSync(envPath, "utf-8")
  const match = content.match(/^FINN_S2S_PRIVATE_KEY=(.+)$/m)
  if (!match) throw new Error("FINN_S2S_PRIVATE_KEY not found in .env.e2e")
  return Buffer.from(match[1].trim(), "base64").toString("utf-8")
}
