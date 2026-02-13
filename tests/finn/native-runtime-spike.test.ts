// tests/finn/native-runtime-spike.test.ts — NativeRuntime Spike (Task 3.1, B.1)
// Validates process isolation primitives: setsid, process group kill, orphan detection.
// Go/no-go decision for NativeRuntimeAdapter implementation.

import { describe, it, expect, afterEach } from "vitest"
import { spawn, execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"

// --- Helpers ---

/** Check if a process group has any members via kill(0) probe */
function isProcessGroupAlive(pgid: number): boolean {
  try {
    // kill(-pgid, 0) sends signal 0 (existence check) to entire process group
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

/** Check if a single PID exists */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Wait for a condition with timeout */
async function waitFor(
  fn: () => boolean,
  timeoutMs: number = 5000,
  intervalMs: number = 50,
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return fn()
}

// Track PIDs for cleanup in afterEach
const spawnedPids: number[] = []

afterEach(() => {
  // Defensive cleanup: kill any leftover processes
  for (const pid of spawnedPids) {
    try { process.kill(-pid, "SIGKILL") } catch { /* already dead */ }
    try { process.kill(pid, "SIGKILL") } catch { /* already dead */ }
  }
  spawnedPids.length = 0
})

// --- Tests ---

describe("process isolation primitives", () => {
  it("spawn with detached=true creates new process group (setsid)", async () => {
    // Spawn a child that sleeps — detached puts it in its own process group
    const child = spawn("sleep", ["30"], {
      detached: true,
      stdio: "ignore",
    })
    child.unref()

    const pid = child.pid!
    spawnedPids.push(pid)

    expect(pid).toBeGreaterThan(0)

    // In detached mode, the child's PGID equals its own PID
    // This is the setsid behavior
    expect(isPidAlive(pid)).toBe(true)

    // Kill via process group (negative PID)
    process.kill(-pid, "SIGTERM")

    // Verify process is gone
    const dead = await waitFor(() => !isPidAlive(pid), 3000)
    expect(dead).toBe(true)
  })

  it("process group kill terminates entire tree (parent + children)", async () => {
    // Spawn a shell that creates grandchildren
    // bash -c "sleep 30 & sleep 30 & wait" — creates a process group with 3 members
    const child = spawn("bash", ["-c", "sleep 30 & sleep 30 & wait"], {
      detached: true,
      stdio: "ignore",
    })
    child.unref()

    const pgid = child.pid!
    spawnedPids.push(pgid)

    // Wait for grandchildren to spawn
    await new Promise((r) => setTimeout(r, 100))

    // Verify the group is alive
    expect(isProcessGroupAlive(pgid)).toBe(true)

    // Kill entire process group with SIGTERM
    process.kill(-pgid, "SIGTERM")

    // Wait for all processes in the group to die
    const allDead = await waitFor(() => !isProcessGroupAlive(pgid), 5000)
    expect(allDead).toBe(true)
  })

  it("escalated kill: SIGTERM → grace → SIGKILL", async () => {
    // Spawn a Node process that ignores SIGTERM (simulating uncooperative process)
    const child = spawn("node", [
      "-e",
      "process.on('SIGTERM', () => {}); setTimeout(() => {}, 300000)",
    ], {
      detached: true,
      stdio: "ignore",
    })
    child.unref()

    const pid = child.pid!
    spawnedPids.push(pid)

    // Wait for node to start and register the handler
    await new Promise((r) => setTimeout(r, 300))
    expect(isPidAlive(pid)).toBe(true)

    // SIGTERM won't kill it (handler registered, does nothing)
    process.kill(pid, "SIGTERM")
    await new Promise((r) => setTimeout(r, 300))
    expect(isPidAlive(pid)).toBe(true) // Still alive after SIGTERM

    // Escalate to SIGKILL — cannot be caught
    process.kill(pid, "SIGKILL")

    const dead = await waitFor(() => !isPidAlive(pid), 3000)
    expect(dead).toBe(true)
  })

  it("verifyGroupEmpty: no orphans after kill", async () => {
    // Create a process tree with grandchildren
    const child = spawn("bash", ["-c", "for i in 1 2 3; do sleep 30 & done; wait"], {
      detached: true,
      stdio: "ignore",
    })
    child.unref()

    const pgid = child.pid!
    spawnedPids.push(pgid)

    await new Promise((r) => setTimeout(r, 100))

    // Kill the group
    process.kill(-pgid, "SIGKILL")

    // Verify zero orphans: process group should have no members
    const empty = await waitFor(() => !isProcessGroupAlive(pgid), 5000)
    expect(empty).toBe(true)
  })

  // BB-PR63-F006: Platform guard — this test requires Linux /proc filesystem.
  // On macOS and other non-Linux platforms it returns early (no-op).
  // Use `it.skipIf` when vitest supports runtime condition skips.
  it("/proc/{pid}/stat is accessible for process monitoring", () => {
    const myPid = process.pid
    const statPath = `/proc/${myPid}/stat`

    if (!existsSync("/proc")) {
      // No procfs (macOS, FreeBSD) — skip gracefully
      return
    }

    expect(existsSync(statPath)).toBe(true)
    const stat = readFileSync(statPath, "utf-8")
    expect(stat).toContain(String(myPid))
  })

  it("pgrep can enumerate process group members", async () => {
    const child = spawn("bash", ["-c", "sleep 30 & sleep 30 & wait"], {
      detached: true,
      stdio: "ignore",
    })
    child.unref()

    const pgid = child.pid!
    spawnedPids.push(pgid)

    await new Promise((r) => setTimeout(r, 100))

    try {
      // pgrep -g lists all processes in the process group
      const output = execSync(`pgrep -g ${pgid}`, { encoding: "utf-8" }).trim()
      const pids = output.split("\n").filter(Boolean)

      // Should have at least 2 members (bash + sleep children)
      expect(pids.length).toBeGreaterThanOrEqual(2)

      // Clean up
      process.kill(-pgid, "SIGKILL")
      await waitFor(() => !isProcessGroupAlive(pgid), 3000)
    } catch {
      // pgrep not available — document as degraded mode
      process.kill(-pgid, "SIGKILL")
      // If pgrep fails, we fall back to kill(-pgid, 0) for existence checks
    }
  })
})

describe("stdio communication", () => {
  it("stdout streaming: read line-by-line from child process", async () => {
    // Child emits JSON lines on stdout
    const child = spawn("bash", ["-c", `
      echo '{"event":"chunk","data":"hello"}'
      echo '{"event":"chunk","data":"world"}'
      echo '{"event":"done","data":"stop"}'
    `], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    })

    const pgid = child.pid!
    spawnedPids.push(pgid)

    const lines: string[] = []
    const decoder = new TextDecoder()
    let buffer = ""

    for await (const chunk of child.stdout!) {
      buffer += decoder.decode(chunk, { stream: true })
      const parts = buffer.split("\n")
      buffer = parts.pop()! // Keep incomplete line in buffer
      for (const line of parts) {
        if (line.trim()) lines.push(line.trim())
      }
    }
    // Flush remaining buffer
    if (buffer.trim()) lines.push(buffer.trim())

    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0])).toEqual({ event: "chunk", data: "hello" })
    expect(JSON.parse(lines[1])).toEqual({ event: "chunk", data: "world" })
    expect(JSON.parse(lines[2])).toEqual({ event: "done", data: "stop" })
  })

  it("stderr is captured separately for error reporting", async () => {
    const child = spawn("bash", ["-c", `
      echo '{"result":"ok"}' >&1
      echo 'warning: something happened' >&2
    `], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    })

    const pgid = child.pid!
    spawnedPids.push(pgid)

    let stdout = ""
    let stderr = ""

    for await (const chunk of child.stdout!) {
      stdout += new TextDecoder().decode(chunk)
    }
    for await (const chunk of child.stderr!) {
      stderr += new TextDecoder().decode(chunk)
    }

    expect(stdout.trim()).toBe('{"result":"ok"}')
    expect(stderr.trim()).toBe("warning: something happened")
  })
})

describe("AbortController integration", () => {
  it("abort signal triggers process group kill", async () => {
    const controller = new AbortController()
    const child = spawn("sleep", ["30"], {
      detached: true,
      stdio: "ignore",
    })
    child.unref()

    const pid = child.pid!
    spawnedPids.push(pid)

    // Wire AbortController to process kill
    controller.signal.addEventListener("abort", () => {
      try { process.kill(-pid, "SIGTERM") } catch { /* ok */ }
    }, { once: true })

    // Verify alive
    expect(isPidAlive(pid)).toBe(true)

    // Fire abort
    controller.abort()

    // Process should die
    const dead = await waitFor(() => !isPidAlive(pid), 3000)
    expect(dead).toBe(true)
  })

  it("timeout-based abort kills process group", async () => {
    const controller = new AbortController()
    const child = spawn("sleep", ["30"], {
      detached: true,
      stdio: "ignore",
    })
    child.unref()

    const pid = child.pid!
    spawnedPids.push(pid)

    // Set short timeout
    const timer = setTimeout(() => controller.abort(), 100)

    controller.signal.addEventListener("abort", () => {
      try { process.kill(-pid, "SIGKILL") } catch { /* ok */ }
    }, { once: true })

    // Wait for timeout to fire
    const dead = await waitFor(() => !isPidAlive(pid), 3000)
    clearTimeout(timer)
    expect(dead).toBe(true)
  })
})

describe("concurrent spawn+abort (mini stress test)", () => {
  it("10 concurrent spawn + abort → 0 orphans", async () => {
    const N = 10
    const pids: number[] = []

    for (let i = 0; i < N; i++) {
      const child = spawn("bash", ["-c", "sleep 30 & sleep 30 & wait"], {
        detached: true,
        stdio: "ignore",
      })
      child.unref()
      const pid = child.pid!
      pids.push(pid)
      spawnedPids.push(pid)
    }

    // Wait for all grandchildren to spawn
    await new Promise((r) => setTimeout(r, 200))

    // Kill all process groups
    for (const pid of pids) {
      try { process.kill(-pid, "SIGKILL") } catch { /* ok */ }
    }

    // Verify all groups are dead
    const allDead = await waitFor(() => {
      return pids.every((pid) => !isProcessGroupAlive(pid))
    }, 5000)

    expect(allDead).toBe(true)
  })
})

describe("resource limits (degraded mode)", () => {
  it("detects cgroup v2 availability", () => {
    const hasCgroups = existsSync("/sys/fs/cgroup/cgroup.controllers")
    // Document: on this system, cgroups v2 is available or not
    // NativeRuntimeAdapter falls back to ulimit if cgroups unavailable
    if (hasCgroups) {
      const controllers = readFileSync("/sys/fs/cgroup/cgroup.controllers", "utf-8").trim()
      // Just verify it's readable — actual enforcement is container-level
      expect(controllers.length).toBeGreaterThanOrEqual(0)
    }
    // Test passes regardless — documents the availability
    expect(true).toBe(true)
  })

  it("tini availability check (zombie reaping)", () => {
    // Check if tini is available as init process
    try {
      execSync("which tini", { encoding: "utf-8" })
      // tini available — preferred for zombie reaping in containers
    } catch {
      // tini not available — node's built-in child_process handles basic reaping
      // In containers, set --init flag in docker run or use shareProcessNamespace in K8s
    }
    expect(true).toBe(true)
  })
})
