// tests/finn/sidecar-manager.test.ts — SidecarManager unit tests (T-1.3)

import assert from "node:assert/strict"
import { defaultSidecarConfig } from "../../src/hounfour/sidecar-manager.js"
import type { SidecarManagerConfig } from "../../src/hounfour/sidecar-manager.js"
import { SidecarManager } from "../../src/hounfour/sidecar-manager.js"

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
  console.log("SidecarManager Tests (T-1.3)")
  console.log("============================")

  // --- Config defaults ---

  await test("defaultSidecarConfig fills defaults", () => {
    const config = defaultSidecarConfig({ env: { CHEVAL_HMAC_SECRET: "test" } })
    assert.equal(config.pythonBin, "python3")
    assert.equal(config.uvicornModule, "uvicorn")
    assert.equal(config.appImport, "adapters.cheval_server:app")
    assert.equal(config.port, 3001)
    assert.equal(config.host, "127.0.0.1")
    assert.equal(config.startupTimeoutMs, 30_000)
    assert.equal(config.shutdownTimeoutMs, 30_000)
    assert.equal(config.restartBackoff.initialMs, 1000)
    assert.equal(config.restartBackoff.maxMs, 30_000)
    assert.equal(config.restartBackoff.multiplier, 2)
  })

  await test("defaultSidecarConfig respects overrides", () => {
    const config = defaultSidecarConfig({
      port: 4001,
      host: "0.0.0.0",
      startupTimeoutMs: 5000,
      restartBackoff: { initialMs: 500, maxMs: 10_000, multiplier: 3 },
      env: { CHEVAL_HMAC_SECRET: "override" },
    })
    assert.equal(config.port, 4001)
    assert.equal(config.host, "0.0.0.0")
    assert.equal(config.startupTimeoutMs, 5000)
    assert.equal(config.restartBackoff.initialMs, 500)
    assert.equal(config.restartBackoff.maxMs, 10_000)
    assert.equal(config.restartBackoff.multiplier, 3)
  })

  // --- SidecarManager state ---

  await test("initial state is stopped", () => {
    const mgr = new SidecarManager({ env: { CHEVAL_HMAC_SECRET: "test" } })
    const status = mgr.getStatus()
    assert.equal(status.state, "stopped")
    assert.equal(status.pid, null)
    assert.equal(status.restartCount, 0)
    assert.equal(status.uptimeMs, 0)
  })

  await test("baseUrl reflects config", () => {
    const mgr = new SidecarManager({ port: 4567, host: "127.0.0.1", env: { CHEVAL_HMAC_SECRET: "test" } })
    assert.equal(mgr.baseUrl, "http://127.0.0.1:4567")
  })

  await test("isRunning is false when stopped", () => {
    const mgr = new SidecarManager({ env: { CHEVAL_HMAC_SECRET: "test" } })
    assert.equal(mgr.isRunning, false)
  })

  await test("port returns configured port", () => {
    const mgr = new SidecarManager({ port: 9999, env: { CHEVAL_HMAC_SECRET: "test" } })
    assert.equal(mgr.port, 9999)
  })

  await test("stop on already-stopped is no-op", async () => {
    const mgr = new SidecarManager({ env: { CHEVAL_HMAC_SECRET: "test" } })
    await mgr.stop() // Should not throw
    assert.equal(mgr.getStatus().state, "stopped")
  })

  console.log("\nDone.")
}

main()
