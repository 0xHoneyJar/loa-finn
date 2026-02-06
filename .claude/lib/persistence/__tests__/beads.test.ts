import { describe, it, expect, vi, beforeEach } from "vitest";
import { BeadsRecoveryHandler, type ICommandExecutor } from "../beads/beads-recovery.js";
import {
  BeadsWALAdapter,
  type IBeadsWAL,
  type IBeadsWALEntry,
  type BeadWALEntry,
} from "../beads/beads-wal-adapter.js";

// ── Mock WAL ───────────────────────────────────────────────

function createMockWAL(): IBeadsWAL & {
  entries: { operation: string; path: string; data?: Buffer }[];
  seq: number;
} {
  const entries: { operation: string; path: string; data?: Buffer }[] = [];
  let seq = 0;

  return {
    entries,
    seq,
    async append(operation: string, path: string, data?: Buffer) {
      seq++;
      entries.push({ operation, path, data });
      return seq;
    },
    async replay(visitor: (entry: IBeadsWALEntry) => void | Promise<void>) {
      for (const e of entries) {
        await visitor({
          operation: e.operation,
          path: e.path,
          data: e.data?.toString("base64"),
        });
      }
    },
    getStatus() {
      return { seq };
    },
  };
}

// ── Mock Command Executor ─────────────────────────────────

function createMockExecutor(): ICommandExecutor & { calls: { binary: string; args: string[] }[] } {
  const calls: { binary: string; args: string[] }[] = [];
  return {
    calls,
    async execFile(binary: string, args: string[]) {
      calls.push({ binary, args });
      return { stdout: "", stderr: "" };
    },
  };
}

describe("BeadsWALAdapter", () => {
  let wal: ReturnType<typeof createMockWAL>;
  let adapter: BeadsWALAdapter;

  beforeEach(() => {
    wal = createMockWAL();
    adapter = new BeadsWALAdapter(wal, { pathPrefix: ".beads/wal" });
  });

  it("records a transition and returns sequence number", async () => {
    const seq = await adapter.recordTransition({
      operation: "create",
      beadId: "bead-123",
      payload: { title: "Test bead", type: "task" },
    });

    expect(seq).toBe(1);
    expect(wal.entries).toHaveLength(1);
    expect(wal.entries[0].path).toContain(".beads/wal/bead-123/");
    expect(wal.entries[0].operation).toBe("write");
  });

  it("replays entries with checksum verification", async () => {
    await adapter.recordTransition({
      operation: "create",
      beadId: "bead-1",
      payload: { title: "First" },
    });
    await adapter.recordTransition({
      operation: "update",
      beadId: "bead-1",
      payload: { status: "done" },
    });

    const entries = await adapter.replay();

    expect(entries).toHaveLength(2);
    expect(entries[0].operation).toBe("create");
    expect(entries[1].operation).toBe("update");
  });

  it("rejects invalid beadId with path traversal chars", async () => {
    await expect(
      adapter.recordTransition({
        operation: "create",
        beadId: "../etc/passwd",
        payload: { title: "malicious" },
      }),
    ).rejects.toThrow("Invalid beadId");
  });

  it("rejects invalid operation type", async () => {
    await expect(
      adapter.recordTransition({
        operation: "rm -rf" as any,
        beadId: "bead-1",
        payload: {},
      }),
    ).rejects.toThrow("Invalid operation");
  });
});

describe("BeadsRecoveryHandler", () => {
  let wal: ReturnType<typeof createMockWAL>;
  let adapter: BeadsWALAdapter;
  let executor: ReturnType<typeof createMockExecutor>;

  beforeEach(() => {
    wal = createMockWAL();
    adapter = new BeadsWALAdapter(wal);
    executor = createMockExecutor();
  });

  it("recovers by replaying WAL entries through br CLI with argv arrays", async () => {
    await adapter.recordTransition({
      operation: "create",
      beadId: "bead-1",
      payload: { title: "Test task", type: "task", priority: 2 },
    });
    await adapter.recordTransition({
      operation: "label",
      beadId: "bead-1",
      payload: { action: "add", labels: ["ready"] },
    });

    const handler = new BeadsRecoveryHandler(adapter, { skipSync: true }, executor);
    const result = await handler.recover();

    expect(result.success).toBe(true);
    expect(result.entriesReplayed).toBe(2);
    expect(result.beadsAffected).toContain("bead-1");
    expect(executor.calls).toHaveLength(2);

    // Verify argv arrays (not shell strings)
    expect(executor.calls[0].binary).toBe("br");
    expect(executor.calls[0].args).toEqual(["create", "Test task", "--type", "task", "--priority", "2"]);
    expect(executor.calls[1].args[0]).toBe("label");
    expect(executor.calls[1].args[1]).toBe("add");
  });

  it("passes shell metacharacters as literal argv values (no injection)", async () => {
    await adapter.recordTransition({
      operation: "create",
      beadId: "bead-1",
      payload: { title: "$(rm -rf /)", type: "task", priority: 2 },
    });

    const handler = new BeadsRecoveryHandler(adapter, { skipSync: true }, executor);
    await handler.recover();

    // The malicious title is passed as a single argv element, not interpreted by shell
    const args = executor.calls[0].args;
    expect(args[0]).toBe("create");
    expect(args[1]).toBe("$(rm -rf /)");  // Literal string, no shell expansion
    expect(args).toContain("--type");
  });

  it("adversarial: backtick injection in title is not interpreted", async () => {
    await adapter.recordTransition({
      operation: "create",
      beadId: "bead-1",
      payload: { title: "`cat /etc/passwd`", type: "task", priority: 2 },
    });

    const handler = new BeadsRecoveryHandler(adapter, { skipSync: true }, executor);
    await handler.recover();

    expect(executor.calls[0].args[1]).toBe("`cat /etc/passwd`");
  });

  it("adversarial: semicolon injection in description is not interpreted", async () => {
    await adapter.recordTransition({
      operation: "create",
      beadId: "bead-1",
      payload: { title: "safe", type: "task", priority: 2, description: "; rm -rf / #" },
    });

    const handler = new BeadsRecoveryHandler(adapter, { skipSync: true }, executor);
    await handler.recover();

    const args = executor.calls[0].args;
    expect(args).toContain("--description");
    const descIdx = args.indexOf("--description");
    expect(args[descIdx + 1]).toBe("; rm -rf / #");
  });

  it("enforces operation and update key whitelists", async () => {
    await adapter.recordTransition({
      operation: "update",
      beadId: "bead-1",
      payload: { title: "New title", malicious_key: "dropped" },
    });

    const handler = new BeadsRecoveryHandler(adapter, { skipSync: true }, executor);
    await handler.recover();

    const args = executor.calls[0].args;
    expect(args).toContain("--title");
    expect(args.join(" ")).not.toContain("malicious_key");
  });

  it("returns empty result when no WAL entries", async () => {
    const handler = new BeadsRecoveryHandler(adapter, { skipSync: true }, executor);
    const result = await handler.recover();

    expect(result.success).toBe(true);
    expect(result.entriesReplayed).toBe(0);
    expect(result.beadsAffected).toEqual([]);
    expect(executor.calls).toHaveLength(0);
  });
});
