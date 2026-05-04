// tests/nft/wal-r2-streaming.test.ts — WAL-to-R2 Segment Streaming Tests (T1.10)

import { createHash } from "node:crypto"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  WalR2Streamer,
  type IR2WalClient,
  type WalManifest,
} from "../../src/nft/wal-r2-streaming.js"

// ---------------------------------------------------------------------------
// Mock R2 Client
// ---------------------------------------------------------------------------

interface MockR2State {
  storage: Map<string, Buffer>
  manifests: Map<string, WalManifest>
}

function createMockR2Client(state?: MockR2State): IR2WalClient & { _state: MockR2State } {
  const s: MockR2State = state ?? {
    storage: new Map<string, Buffer>(),
    manifests: new Map<string, WalManifest>(),
  }

  return {
    _state: s,
    putSegment: vi.fn(async (key: string, data: Buffer, _sha256: string) => {
      s.storage.set(key, data)
      return true
    }),
    headSegment: vi.fn(async (key: string, _expectedSha256: string) => {
      return s.storage.has(key)
    }),
    getManifest: vi.fn(async (key: string) => {
      return s.manifests.get(key) ?? null
    }),
    putManifest: vi.fn(async (key: string, manifest: WalManifest) => {
      s.manifests.set(key, structuredClone(manifest))
      return true
    }),
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(content: string): Buffer {
  return Buffer.from(content, "utf-8")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WalR2Streamer", () => {
  let client: ReturnType<typeof createMockR2Client>
  let streamer: WalR2Streamer

  beforeEach(() => {
    vi.useFakeTimers()
    client = createMockR2Client()
    streamer = new WalR2Streamer({
      nftId: "test-nft-42",
      r2Client: client,
      flushRecordThreshold: 3,
      flushIntervalSeconds: 10,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // -----------------------------------------------------------------------
  // Core flush behavior
  // -----------------------------------------------------------------------

  describe("flush", () => {
    it("uploads segment and updates manifest after flush", async () => {
      streamer.addRecord(makeRecord("record-0"), 0)
      streamer.addRecord(makeRecord("record-1"), 1)

      const ok = await streamer.flush()

      expect(ok).toBe(true)
      expect(client.putSegment).toHaveBeenCalledTimes(1)
      expect(client.headSegment).toHaveBeenCalledTimes(1)
      expect(client.putManifest).toHaveBeenCalledTimes(1)

      // Verify segment key naming convention
      const putCall = (client.putSegment as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(putCall[0]).toBe("wal-segments/test-nft-42/0-1.bin")

      // Verify segment data is the concatenation of both records
      const expectedData = Buffer.concat([makeRecord("record-0"), makeRecord("record-1")])
      expect(putCall[1]).toEqual(expectedData)

      // Verify manifest was updated
      const manifest = client._state.manifests.get("wal-segments/test-nft-42/manifest.json")
      expect(manifest).toBeDefined()
      expect(manifest!.nft_id).toBe("test-nft-42")
      expect(manifest!.segments).toHaveLength(1)
      expect(manifest!.segments[0].key).toBe("wal-segments/test-nft-42/0-1.bin")
      expect(manifest!.segments[0].start_offset).toBe(0)
      expect(manifest!.segments[0].end_offset).toBe(1)
      expect(manifest!.last_committed_offset).toBe(1)
    })

    it("returns true for empty buffer", async () => {
      const ok = await streamer.flush()
      expect(ok).toBe(true)
      expect(client.putSegment).not.toHaveBeenCalled()
    })

    it("clears buffer on successful flush", async () => {
      streamer.addRecord(makeRecord("a"), 0)
      streamer.addRecord(makeRecord("b"), 1)

      expect(streamer.pendingRecordCount).toBe(2)

      await streamer.flush()

      expect(streamer.pendingRecordCount).toBe(0)
    })

    it("keeps buffer intact on failed PUT", async () => {
      ;(client.putSegment as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)

      streamer.addRecord(makeRecord("a"), 0)
      streamer.addRecord(makeRecord("b"), 1)

      const ok = await streamer.flush()

      expect(ok).toBe(false)
      expect(streamer.pendingRecordCount).toBe(2)
      // Manifest should NOT be updated when PUT fails
      expect(client.putManifest).not.toHaveBeenCalled()
    })

    it("keeps buffer intact on failed HEAD verification", async () => {
      ;(client.headSegment as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)

      streamer.addRecord(makeRecord("a"), 0)

      const ok = await streamer.flush()

      expect(ok).toBe(false)
      expect(streamer.pendingRecordCount).toBe(1)
      expect(client.putManifest).not.toHaveBeenCalled()
    })

    it("keeps buffer intact on failed manifest update", async () => {
      ;(client.putManifest as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)

      streamer.addRecord(makeRecord("a"), 0)

      const ok = await streamer.flush()

      expect(ok).toBe(false)
      expect(streamer.pendingRecordCount).toBe(1)
    })
  })

  // -----------------------------------------------------------------------
  // SHA-256 verification
  // -----------------------------------------------------------------------

  describe("SHA-256 checksum", () => {
    it("passes correct SHA-256 to putSegment", async () => {
      const record = makeRecord("hello-wal")
      streamer.addRecord(record, 0)

      await streamer.flush()

      const expectedSha = createHash("sha256").update(record).digest("hex")
      const putCall = (client.putSegment as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(putCall[2]).toBe(expectedSha)
    })

    it("computes SHA-256 over concatenated segment, not individual records", async () => {
      const r0 = makeRecord("rec-0")
      const r1 = makeRecord("rec-1")
      streamer.addRecord(r0, 0)
      streamer.addRecord(r1, 1)

      await streamer.flush()

      const combined = Buffer.concat([r0, r1])
      const expectedSha = createHash("sha256").update(combined).digest("hex")
      const putCall = (client.putSegment as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(putCall[2]).toBe(expectedSha)
    })

    it("records SHA-256 in manifest segment entry", async () => {
      const record = makeRecord("single")
      streamer.addRecord(record, 0)

      await streamer.flush()

      const expectedSha = createHash("sha256").update(record).digest("hex")
      const manifest = client._state.manifests.get("wal-segments/test-nft-42/manifest.json")
      expect(manifest!.segments[0].sha256).toBe(expectedSha)
    })
  })

  // -----------------------------------------------------------------------
  // Segment naming convention
  // -----------------------------------------------------------------------

  describe("segment naming", () => {
    it("uses wal-segments/{nftId}/{start}-{end}.bin format", async () => {
      streamer.addRecord(makeRecord("a"), 5)
      streamer.addRecord(makeRecord("b"), 6)

      await streamer.flush()

      const putCall = (client.putSegment as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(putCall[0]).toBe("wal-segments/test-nft-42/5-6.bin")
    })

    it("names single-record segment with same start and end", async () => {
      streamer.addRecord(makeRecord("only"), 10)

      await streamer.flush()

      const putCall = (client.putSegment as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(putCall[0]).toBe("wal-segments/test-nft-42/10-10.bin")
    })

    it("uses manifest key wal-segments/{nftId}/manifest.json", async () => {
      streamer.addRecord(makeRecord("x"), 0)

      await streamer.flush()

      const manifestCall = (client.putManifest as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(manifestCall[0]).toBe("wal-segments/test-nft-42/manifest.json")
    })
  })

  // -----------------------------------------------------------------------
  // Auto-flush at record threshold
  // -----------------------------------------------------------------------

  describe("auto-flush at threshold", () => {
    it("triggers flush when record count reaches threshold", async () => {
      // Threshold is 3 in our test config
      streamer.addRecord(makeRecord("a"), 0)
      streamer.addRecord(makeRecord("b"), 1)
      expect(client.putSegment).not.toHaveBeenCalled()

      streamer.addRecord(makeRecord("c"), 2) // This hits the threshold

      // Auto-flush is fire-and-forget — flush the microtask queue
      // by awaiting a resolved promise chain (gives the internal flush() time to run)
      await new Promise((r) => queueMicrotask(r))
      // One more tick to allow the full async chain (putSegment, headSegment, manifest) to complete
      await new Promise((r) => queueMicrotask(r))
      await new Promise((r) => queueMicrotask(r))
      await new Promise((r) => queueMicrotask(r))
      await new Promise((r) => queueMicrotask(r))

      expect(client.putSegment).toHaveBeenCalledTimes(1)
    })
  })

  // -----------------------------------------------------------------------
  // Manifest protocol
  // -----------------------------------------------------------------------

  describe("manifest protocol", () => {
    it("creates new manifest when none exists", async () => {
      streamer.addRecord(makeRecord("first"), 0)

      await streamer.flush()

      const manifest = client._state.manifests.get("wal-segments/test-nft-42/manifest.json")
      expect(manifest).toBeDefined()
      expect(manifest!.nft_id).toBe("test-nft-42")
      expect(manifest!.segments).toHaveLength(1)
    })

    it("appends to existing manifest on subsequent flushes", async () => {
      streamer.addRecord(makeRecord("first"), 0)
      await streamer.flush()

      streamer.addRecord(makeRecord("second"), 1)
      await streamer.flush()

      const manifest = client._state.manifests.get("wal-segments/test-nft-42/manifest.json")
      expect(manifest!.segments).toHaveLength(2)
      expect(manifest!.segments[0].key).toBe("wal-segments/test-nft-42/0-0.bin")
      expect(manifest!.segments[1].key).toBe("wal-segments/test-nft-42/1-1.bin")
      expect(manifest!.last_committed_offset).toBe(1)
    })

    it("updates last_committed_offset to end_offset of latest segment", async () => {
      // Use only 2 records (below threshold of 3) so auto-flush does not interfere
      streamer.addRecord(makeRecord("a"), 0)
      streamer.addRecord(makeRecord("b"), 1)

      await streamer.flush()

      const manifest = client._state.manifests.get("wal-segments/test-nft-42/manifest.json")
      expect(manifest!.last_committed_offset).toBe(1)
    })
  })

  // -----------------------------------------------------------------------
  // Timer-based auto-flush (start/stop)
  // -----------------------------------------------------------------------

  describe("start/stop", () => {
    it("start() enables periodic auto-flush", async () => {
      streamer.addRecord(makeRecord("a"), 0)
      streamer.start()

      // Advance past the flush interval (10s in test config)
      await vi.advanceTimersByTimeAsync(10_000)

      expect(client.putSegment).toHaveBeenCalledTimes(1)
    })

    it("stop() clears timer and flushes remaining", async () => {
      streamer.addRecord(makeRecord("a"), 0)

      await streamer.stop()

      expect(client.putSegment).toHaveBeenCalledTimes(1)
      expect(streamer.pendingRecordCount).toBe(0)
    })

    it("stop() is safe when no records buffered", async () => {
      await streamer.stop()
      expect(client.putSegment).not.toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // Offset tracking
  // -----------------------------------------------------------------------

  describe("offset tracking", () => {
    it("tracks current offset correctly", () => {
      expect(streamer.offset).toBe(0)

      streamer.addRecord(makeRecord("a"), 0)
      expect(streamer.offset).toBe(1)

      streamer.addRecord(makeRecord("b"), 1)
      expect(streamer.offset).toBe(2)
    })

    it("handles non-zero starting offsets", async () => {
      streamer.addRecord(makeRecord("a"), 100)
      streamer.addRecord(makeRecord("b"), 101)

      await streamer.flush()

      const putCall = (client.putSegment as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(putCall[0]).toBe("wal-segments/test-nft-42/100-101.bin")
    })
  })

  // -----------------------------------------------------------------------
  // Retry behavior
  // -----------------------------------------------------------------------

  describe("retry on failure", () => {
    it("retries successfully after a failed flush", async () => {
      ;(client.putSegment as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)

      streamer.addRecord(makeRecord("a"), 0)

      // First attempt fails
      const fail = await streamer.flush()
      expect(fail).toBe(false)
      expect(streamer.pendingRecordCount).toBe(1)

      // putSegment now succeeds (default mock)
      const ok = await streamer.flush()
      expect(ok).toBe(true)
      expect(streamer.pendingRecordCount).toBe(0)
    })
  })
})
