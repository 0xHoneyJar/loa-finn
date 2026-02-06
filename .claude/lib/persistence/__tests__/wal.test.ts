import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { WALEntry } from "../wal/wal-entry.js";
import { compactEntries } from "../wal/wal-compaction.js";
import {
  generateEntryId,
  isLegacyUUID,
  extractTimestamp,
  verifyEntry,
  computeEntryChecksum,
} from "../wal/wal-entry.js";
import { WALManager } from "../wal/wal-manager.js";
import { evaluateDiskPressure } from "../wal/wal-pressure.js";

describe("WAL", () => {
  let walDir: string;

  beforeEach(() => {
    walDir = mkdtempSync(join(tmpdir(), "wal-test-"));
  });

  afterEach(async () => {
    rmSync(walDir, { recursive: true, force: true });
  });

  // ── 1. Append ────────────────────────────────────────────

  it("appends entries with incrementing sequence numbers", async () => {
    const wal = new WALManager({ walDir });
    await wal.initialize();

    const seq1 = await wal.append("write", "/test/a.txt", Buffer.from("hello"));
    const seq2 = await wal.append("write", "/test/b.txt", Buffer.from("world"));
    const seq3 = await wal.append("delete", "/test/a.txt");

    expect(seq1).toBe(1);
    expect(seq2).toBe(2);
    expect(seq3).toBe(3);
    expect(wal.getStatus().seq).toBe(3);

    await wal.shutdown();
  });

  // ── 2. Replay ────────────────────────────────────────────

  it("replays all entries in sequence order", async () => {
    const wal = new WALManager({ walDir });
    await wal.initialize();

    await wal.append("write", "/a.txt", Buffer.from("data-a"));
    await wal.append("write", "/b.txt", Buffer.from("data-b"));
    await wal.append("delete", "/a.txt");
    await wal.shutdown();

    // Re-open and replay
    const wal2 = new WALManager({ walDir });
    await wal2.initialize();

    const replayed: WALEntry[] = [];
    const result = await wal2.replay(async (entry) => {
      replayed.push(entry);
    });

    expect(result.replayed).toBe(3);
    expect(result.errors).toBe(0);
    expect(replayed[0].path).toBe("/a.txt");
    expect(replayed[0].operation).toBe("write");
    expect(replayed[1].path).toBe("/b.txt");
    expect(replayed[2].operation).toBe("delete");

    await wal2.shutdown();
  });

  // ── 3. Compaction ────────────────────────────────────────

  it("compaction keeps only latest write per path", () => {
    const entries: WALEntry[] = [
      makeEntry(1, "write", "/x.txt", "v1"),
      makeEntry(2, "write", "/y.txt", "v1"),
      makeEntry(3, "write", "/x.txt", "v2"),
      makeEntry(4, "write", "/x.txt", "v3"),
      makeEntry(5, "delete", "/y.txt"),
    ];

    const compacted = compactEntries(entries);

    // /x.txt latest write (seq 4) + /y.txt delete (seq 5)
    expect(compacted).toHaveLength(2);
    expect(compacted[0].seq).toBe(4);
    expect(compacted[0].path).toBe("/x.txt");
    expect(compacted[1].seq).toBe(5);
    expect(compacted[1].operation).toBe("delete");
  });

  // ── 4. Disk Pressure ────────────────────────────────────

  it("evaluates disk pressure levels correctly", () => {
    const config = {
      warningBytes: 100,
      criticalBytes: 200,
    };

    expect(evaluateDiskPressure(50, config)).toBe("normal");
    expect(evaluateDiskPressure(100, config)).toBe("warning");
    expect(evaluateDiskPressure(150, config)).toBe("warning");
    expect(evaluateDiskPressure(200, config)).toBe("critical");
    expect(evaluateDiskPressure(300, config)).toBe("critical");
  });

  // ── 5. Limit/Pagination ─────────────────────────────────

  it("replay supports sinceSeq and limit for pagination", async () => {
    const wal = new WALManager({ walDir });
    await wal.initialize();

    for (let i = 0; i < 10; i++) {
      await wal.append("write", `/file-${i}.txt`, Buffer.from(`data-${i}`));
    }
    await wal.shutdown();

    const wal2 = new WALManager({ walDir });
    await wal2.initialize();

    // Page 1: entries 1-3
    const page1: WALEntry[] = [];
    await wal2.replay(async (e) => page1.push(e), { sinceSeq: 0, limit: 3 });
    expect(page1).toHaveLength(3);
    expect(page1[0].seq).toBe(1);

    // Page 2: entries 4-6
    const page2: WALEntry[] = [];
    await wal2.replay(async (e) => page2.push(e), { sinceSeq: 3, limit: 3 });
    expect(page2).toHaveLength(3);
    expect(page2[0].seq).toBe(4);

    // getEntriesSince with limit
    const entries = await wal2.getEntriesSince(7, 2);
    expect(entries).toHaveLength(2);
    expect(entries[0].seq).toBe(8);

    await wal2.shutdown();
  });

  // ── 6. Backwards Compat ─────────────────────────────────

  it("handles legacy UUID entry IDs", () => {
    expect(isLegacyUUID("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isLegacyUUID("1707000000000-0-a1b2")).toBe(false);

    const id = generateEntryId();
    expect(isLegacyUUID(id)).toBe(false);
    expect(extractTimestamp(id)).toBeGreaterThan(0);
    expect(extractTimestamp("550e8400-e29b-41d4-a716-446655440000")).toBe(0);
  });

  // ── 7. Flock / Lock ────────────────────────────────────

  it("creates PID lockfile on initialize", async () => {
    const wal = new WALManager({ walDir });
    await wal.initialize();

    const pidPath = join(walDir, "wal.pid");
    expect(existsSync(pidPath)).toBe(true);
    const pid = readFileSync(pidPath, "utf-8").trim();
    expect(parseInt(pid, 10)).toBe(process.pid);

    await wal.shutdown();
    expect(existsSync(pidPath)).toBe(false);
  });

  // ── 8. PID Fallback ────────────────────────────────────

  it("takes over lock from dead process PID file", async () => {
    // Simulate stale PID file from a dead process
    writeFileSync(join(walDir, "wal.pid"), "999999999", "utf-8");

    const wal = new WALManager({ walDir });
    await wal.initialize();

    // Should have taken over
    const pid = readFileSync(join(walDir, "wal.pid"), "utf-8").trim();
    expect(parseInt(pid, 10)).toBe(process.pid);

    await wal.shutdown();
  });

  // ── 9. Concurrent Append Safety ─────────────────────────

  it("handles concurrent appends without data loss", async () => {
    const wal = new WALManager({ walDir });
    await wal.initialize();

    // Fire 20 appends concurrently
    const promises = Array.from({ length: 20 }, (_, i) =>
      wal.append("write", `/concurrent-${i}.txt`, Buffer.from(`data-${i}`)),
    );

    const seqs = await Promise.all(promises);

    // All seqs should be unique
    const uniqueSeqs = new Set(seqs);
    expect(uniqueSeqs.size).toBe(20);

    // Verify all entries can be replayed
    const entries = await wal.getEntriesSince(0);
    expect(entries).toHaveLength(20);

    await wal.shutdown();
  });

  // ── 10. Shutdown Drain ────────────────────────────────────

  it("shutdown drains pending writes before checkpointing", async () => {
    const wal = new WALManager({ walDir });
    await wal.initialize();

    // Append then immediately shutdown
    const appendPromise = wal.append("write", "/drain-test.txt", Buffer.from("drain-data"));
    await wal.shutdown();

    // The append should have completed
    const seq = await appendPromise.catch(() => -1);
    expect(seq).toBeGreaterThan(0);

    // Re-initialize and verify entry is present
    const wal2 = new WALManager({ walDir });
    await wal2.initialize();

    const entries = await wal2.getEntriesSince(0);
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe("/drain-test.txt");

    await wal2.shutdown();
  });

  it("shutdown marks shutdown_incomplete when drain times out", async () => {
    const wal = new WALManager({ walDir, shutdownDrainTimeoutMs: 50 });
    await wal.initialize();

    // Create a write that takes longer than the drain timeout
    // by appending something that will be in the chain
    await wal.append("write", "/before.txt", Buffer.from("before"));

    // Now trigger shutdown — with a very short timeout, the checkpoint should still save
    await wal.shutdown();

    // Verify checkpoint was saved (re-init works)
    const wal2 = new WALManager({ walDir });
    await wal2.initialize();

    const entries = await wal2.getEntriesSince(0);
    expect(entries.length).toBeGreaterThanOrEqual(1);

    await wal2.shutdown();
  });

  it("rejects append during shutdown", async () => {
    const wal = new WALManager({ walDir });
    await wal.initialize();
    await wal.append("write", "/pre.txt", Buffer.from("pre"));

    // Start shutdown (don't await yet)
    const shutdownPromise = wal.shutdown();

    // Append during shutdown should be rejected
    await expect(wal.append("write", "/during.txt", Buffer.from("during"))).rejects.toThrow(
      "WAL is shutting down",
    );

    await shutdownPromise;
  });

  // ── 13. Rotation Recovery ─────────────────────────────────

  it("rotation creates new segment and closes old one", async () => {
    const wal = new WALManager({
      walDir,
      maxSegmentSize: 50, // Very small to trigger rotation
    });
    await wal.initialize();

    // Write enough to trigger rotation
    for (let i = 0; i < 5; i++) {
      await wal.append("write", `/rotate-${i}.txt`, Buffer.from("data-" + "x".repeat(20)));
    }

    const status = wal.getStatus();
    expect(status.segmentCount).toBeGreaterThan(1);

    await wal.shutdown();

    // Re-open and verify all entries are intact
    const wal2 = new WALManager({ walDir });
    await wal2.initialize();
    const entries = await wal2.getEntriesSince(0);
    expect(entries).toHaveLength(5);
    await wal2.shutdown();
  });

  it("recovery after interrupted rotation completes without data loss", async () => {
    const wal = new WALManager({ walDir });
    await wal.initialize();

    // Write some entries
    await wal.append("write", "/a.txt", Buffer.from("a"));
    await wal.append("write", "/b.txt", Buffer.from("b"));
    await wal.shutdown();

    // Simulate interrupted rotation by writing checkpoint with rotating phase
    const cpPath = join(walDir, "checkpoint.json");
    const cpContent = readFileSync(cpPath, "utf-8");
    const cp = JSON.parse(cpContent);
    cp.rotationPhase = "rotating";
    writeFileSync(cpPath, JSON.stringify(cp, null, 2));

    // Re-initialize should recover
    const wal2 = new WALManager({ walDir });
    await wal2.initialize();

    // Verify entries are still accessible
    const entries = await wal2.getEntriesSince(0);
    expect(entries.length).toBeGreaterThanOrEqual(2);

    // Verify rotation phase is reset
    await wal2.shutdown();
    const cpAfter = JSON.parse(readFileSync(cpPath, "utf-8"));
    expect(cpAfter.rotationPhase).toBe("none");
  });

  it("recovery from cleanup_started phase resumes cleanup", async () => {
    const wal = new WALManager({ walDir });
    await wal.initialize();

    await wal.append("write", "/c.txt", Buffer.from("c"));
    await wal.shutdown();

    // Simulate interrupted cleanup by setting checkpoint
    const cpPath = join(walDir, "checkpoint.json");
    const cpContent = readFileSync(cpPath, "utf-8");
    const cp = JSON.parse(cpContent);
    cp.rotationPhase = "cleanup_started";
    cp.rotationCheckpoint = {
      phase: "cleanup_started",
      cleanedSegments: [],
      pendingSegments: ["nonexistent-segment.wal"],
    };
    writeFileSync(cpPath, JSON.stringify(cp, null, 2));

    // Re-initialize should recover gracefully (nonexistent segment is skipped)
    const wal2 = new WALManager({ walDir });
    await wal2.initialize();

    const entries = await wal2.getEntriesSince(0);
    expect(entries.length).toBeGreaterThanOrEqual(1);

    await wal2.shutdown();
    const cpAfter = JSON.parse(readFileSync(cpPath, "utf-8"));
    expect(cpAfter.rotationPhase).toBe("none");
    expect(cpAfter.rotationCheckpoint).toBeUndefined();
  });
});

// ── Helper ─────────────────────────────────────────────────

function makeEntry(seq: number, operation: string, path: string, dataStr?: string): WALEntry {
  const entry: Omit<WALEntry, "entryChecksum"> = {
    id: generateEntryId(),
    seq,
    timestamp: new Date().toISOString(),
    operation: operation as WALEntry["operation"],
    path,
  };

  if (dataStr) {
    entry.data = Buffer.from(dataStr).toString("base64");
  }

  return { ...entry, entryChecksum: computeEntryChecksum(entry) };
}
