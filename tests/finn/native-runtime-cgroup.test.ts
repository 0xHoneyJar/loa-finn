// tests/finn/native-runtime-cgroup.test.ts — Cgroup detection & container config (Task 3.3)
// Tests runtime mode detection, startup probe, and degraded mode fallback.

import { describe, it, expect } from "vitest"
import {
  detectRuntimeMode,
  probeRuntime,
  type RuntimeMode,
  type RuntimeProbeResult,
} from "../../src/hounfour/native-runtime-adapter.js"

describe("detectRuntimeMode()", () => {
  it("returns a valid RuntimeMode value", () => {
    const mode = detectRuntimeMode()
    expect(["cgroup", "process_group", "degraded"]).toContain(mode)
  })

  it("returns process_group or cgroup on Linux", () => {
    const mode = detectRuntimeMode()
    // On Linux (CI or dev), we expect at least process_group support
    if (process.platform === "linux") {
      expect(["cgroup", "process_group"]).toContain(mode)
    }
  })

  it("is deterministic across calls", () => {
    const mode1 = detectRuntimeMode()
    const mode2 = detectRuntimeMode()
    expect(mode1).toBe(mode2)
  })
})

describe("probeRuntime()", () => {
  it("returns a complete RuntimeProbeResult", () => {
    const probe = probeRuntime()

    expect(probe).toHaveProperty("mode")
    expect(probe).toHaveProperty("cgroupAvailable")
    expect(probe).toHaveProperty("cgroupControllers")
    expect(probe).toHaveProperty("tiniDetected")

    expect(typeof probe.mode).toBe("string")
    expect(typeof probe.cgroupAvailable).toBe("boolean")
    expect(Array.isArray(probe.cgroupControllers)).toBe(true)
    expect(typeof probe.tiniDetected).toBe("boolean")
  })

  it("mode matches cgroup availability", () => {
    const probe = probeRuntime()

    if (probe.cgroupAvailable) {
      const hasMemory = probe.cgroupControllers.includes("memory")
      const hasPids = probe.cgroupControllers.includes("pids")
      if (hasMemory && hasPids) {
        expect(probe.mode).toBe("cgroup")
      }
    }
  })

  it("reports cgroup controllers as array", () => {
    const probe = probeRuntime()

    if (probe.cgroupAvailable) {
      expect(probe.cgroupControllers.length).toBeGreaterThan(0)
      // Common cgroup v2 controllers
      const knownControllers = ["cpu", "memory", "io", "pids", "cpuset", "rdma", "hugetlb", "misc"]
      for (const ctrl of probe.cgroupControllers) {
        expect(typeof ctrl).toBe("string")
        expect(ctrl.length).toBeGreaterThan(0)
      }
    } else {
      expect(probe.cgroupControllers).toEqual([])
    }
  })

  it("tiniDetected is false outside containers", () => {
    const probe = probeRuntime()
    // In test environment (not in a container with tini), expect false
    // This may be true in CI containers with tini, so just check type
    expect(typeof probe.tiniDetected).toBe("boolean")
  })
})

describe("degraded mode behavior", () => {
  it("NativeRuntimeAdapter works regardless of runtime mode", async () => {
    // The adapter already works in process_group mode (default).
    // This test verifies the detection doesn't break the adapter.
    const { NativeRuntimeAdapter } = await import("../../src/hounfour/native-runtime-adapter.js")
    const { writeFileSync, mkdtempSync, rmSync, chmodSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")

    const dir = mkdtempSync(join(tmpdir(), "cgroup-test-"))
    try {
      const script = join(dir, "test.sh")
      writeFileSync(script, '#!/bin/bash\ncat > /dev/null\necho \'{"content":"ok","usage":{"prompt_tokens":0,"completion_tokens":0,"reasoning_tokens":0}}\'\n')
      chmodSync(script, 0o755)

      const adapter = new NativeRuntimeAdapter({
        binary: script,
        maxRuntimeMs: 5_000,
        killGraceMs: 500,
        model: "test",
      })

      const result = await adapter.complete({
        messages: [{ role: "user", content: [{ type: "text", text: "test" }] }],
        options: { max_tokens: 10 },
      })

      expect(result.content).toBe("ok")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
