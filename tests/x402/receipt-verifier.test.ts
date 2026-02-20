// tests/x402/receipt-verifier.test.ts — Receipt Verifier Tests (Sprint 2 T2.4)

import { describe, it, expect, beforeEach } from "vitest"
import {
  X402ReceiptVerifier,
  X402VerifyError,
  type VerificationFailure,
} from "../../src/x402/receipt-verifier.js"
import {
  signChallenge,
  computeRequestBinding,
  type X402Challenge,
} from "../../src/x402/hmac.js"
import { storeChallenge } from "../../src/x402/atomic-verify.js"
import { USDC_BASE_ADDRESS } from "../../src/x402/types.js"
import type { RedisCommandClient } from "../../src/hounfour/redis/client.js"
import type { RpcPool } from "../../src/x402/rpc-pool.js"
import { encodeEventTopics, encodeAbiParameters, type Log } from "viem"

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const SECRET = "test-secret-for-hmac-signing-32b"
const SECRET_OLD = "old-secret-for-rotation-testing!"
const WALLET = "0x1234567890abcdef1234567890abcdef12345678"
const TX_HASH = "0xaabbccddee1234567890aabbccddee1234567890aabbccddee1234567890aabb"

// ---------------------------------------------------------------------------
// Mock Redis (same as atomic-verify tests)
// ---------------------------------------------------------------------------

function createMockRedis(): RedisCommandClient {
  const store = new Map<string, { value: string; expiresAt: number }>()

  function isExpired(key: string): boolean {
    const entry = store.get(key)
    if (!entry) return true
    if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
      store.delete(key)
      return true
    }
    return false
  }

  return {
    async get(key: string) {
      if (isExpired(key)) return null
      return store.get(key)?.value ?? null
    },
    async set(key: string, value: string, ...args: (string | number)[]) {
      let ttl = 0
      for (let i = 0; i < args.length; i++) {
        if (String(args[i]).toUpperCase() === "EX" && i + 1 < args.length) {
          ttl = Number(args[i + 1])
        }
        if (String(args[i]).toUpperCase() === "NX") {
          if (store.has(key) && !isExpired(key)) return null
        }
      }
      store.set(key, {
        value,
        expiresAt: ttl > 0 ? Date.now() + ttl * 1000 : 0,
      })
      return "OK"
    },
    async del(...keys: string[]) {
      let count = 0
      for (const k of keys) { if (store.delete(k)) count++ }
      return count
    },
    async exists(...keys: string[]) {
      return keys.filter((k) => !isExpired(k) && store.has(k)).length
    },
    async eval(script: string, numkeys: number, ...args: (string | number)[]) {
      const keys = args.slice(0, numkeys).map(String)
      const argv = args.slice(numkeys).map(String)
      const challengeKey = keys[0]
      const replayKey = keys[1]
      const replayTtl = Number(argv[0])
      const txHash = argv[1]

      const challenge = store.get(challengeKey)
      if (!challenge || isExpired(challengeKey)) return 1
      const consumedKey = `${challengeKey}:consumed`
      if (store.has(consumedKey) && !isExpired(consumedKey)) return 3
      if (store.has(replayKey) && !isExpired(replayKey)) return 2
      store.set(consumedKey, { value: "1", expiresAt: Date.now() + 300_000 })
      store.set(replayKey, { value: txHash, expiresAt: Date.now() + replayTtl * 1000 })
      store.delete(challengeKey)
      return 0
    },
    async incrby() { return 0 },
    async incrbyfloat() { return "0" },
    async expire() { return 0 },
    async ping() { return "PONG" },
    async hgetall() { return {} },
    async hincrby() { return 0 },
    async zadd() { return 0 },
    async zpopmin() { return [] },
    async zremrangebyscore() { return 0 },
    async zcard() { return 0 },
    async publish() { return 0 },
    async quit() { return "OK" },
  }
}

// ---------------------------------------------------------------------------
// Mock RPC Pool
// ---------------------------------------------------------------------------

function createMockRpcPool(opts: {
  receipt?: {
    status: "success" | "reverted"
    blockNumber: bigint
    logs: Log[]
  } | null
  blockNumber?: bigint
  error?: Error
}): RpcPool {
  return {
    async execute<T>(fn: (client: any) => Promise<T>): Promise<T> {
      if (opts.error) throw opts.error

      // Create a mock client that responds to getTransactionReceipt and getBlockNumber
      const mockClient = {
        getTransactionReceipt: async () => opts.receipt,
        getBlockNumber: async () => opts.blockNumber ?? 1000n,
      }
      return fn(mockClient)
    },
    getHealth: () => [{ name: "mock", state: "closed" as const, priority: 0 }],
  } as unknown as RpcPool
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TRANSFER_ABI = [{
  type: "event" as const,
  name: "Transfer" as const,
  inputs: [
    { type: "address" as const, name: "from" as const, indexed: true },
    { type: "address" as const, name: "to" as const, indexed: true },
    { type: "uint256" as const, name: "value" as const, indexed: false },
  ],
}]

function makeTransferLog(from: string, to: string, value: bigint): Log {
  // Build topics: event signature + indexed args
  const topics = encodeEventTopics({
    abi: TRANSFER_ABI,
    eventName: "Transfer",
    args: {
      from: from as `0x${string}`,
      to: to as `0x${string}`,
    },
  })

  // Encode non-indexed args as data
  const data = encodeAbiParameters(
    [{ type: "uint256" }],
    [value],
  )

  return {
    address: USDC_BASE_ADDRESS as `0x${string}`,
    blockHash: "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`,
    blockNumber: 900n,
    data,
    logIndex: 0,
    topics,
    transactionHash: TX_HASH as `0x${string}`,
    transactionIndex: 0,
    removed: false,
  }
}

async function setupChallenge(
  redis: RedisCommandClient,
  secret: string,
  overrides?: Partial<Omit<X402Challenge, "hmac">>,
): Promise<X402Challenge> {
  const binding = computeRequestBinding({
    token_id: "0x1",
    model: "claude-opus-4-6",
    max_tokens: 4096,
  })
  const now = Math.floor(Date.now() / 1000)

  const fields: Omit<X402Challenge, "hmac"> = {
    amount: "100000",
    recipient: WALLET,
    chain_id: 8453,
    token: USDC_BASE_ADDRESS,
    nonce: "test-nonce-" + Math.random().toString(36).slice(2),
    expiry: now + 300,
    request_path: "/api/v1/agent/chat",
    request_method: "POST",
    request_binding: binding,
    ...overrides,
  }

  const challenge = signChallenge(fields, secret)
  await storeChallenge(redis, challenge.nonce, JSON.stringify(challenge), 300)
  return challenge
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("X402ReceiptVerifier", () => {
  let redis: RedisCommandClient
  let failures: VerificationFailure[]

  beforeEach(() => {
    redis = createMockRedis()
    failures = []
  })

  function createVerifier(
    rpcPool: RpcPool,
    opts?: { secretPrevious?: string },
  ) {
    return new X402ReceiptVerifier({
      redis,
      rpcPool,
      challengeSecret: SECRET,
      challengeSecretPrevious: opts?.secretPrevious,
      minConfirmations: 10,
      onVerificationFailure: async (f) => { failures.push(f) },
    })
  }

  it("full verification: valid receipt passes", async () => {
    const challenge = await setupChallenge(redis, SECRET)
    const transferLog = makeTransferLog(
      "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      WALLET,
      BigInt(challenge.amount),
    )

    const rpcPool = createMockRpcPool({
      receipt: {
        status: "success",
        blockNumber: 900n,
        logs: [transferLog],
      },
      blockNumber: 1000n, // 100 confirmations
    })

    const verifier = createVerifier(rpcPool)
    const result = await verifier.verify({
      tx_hash: TX_HASH,
      nonce: challenge.nonce,
      request_path: "/api/v1/agent/chat",
      request_method: "POST",
      token_id: "0x1",
      model: "claude-opus-4-6",
      max_tokens: 4096,
    })

    expect(result.tx_hash).toBe(TX_HASH)
    expect(result.confirmations).toBe(100)
    expect(result.amount).toBe(challenge.amount)
  })

  it("nonce_not_found: missing challenge → 402", async () => {
    const rpcPool = createMockRpcPool({ receipt: null })
    const verifier = createVerifier(rpcPool)

    await expect(
      verifier.verify({
        tx_hash: TX_HASH,
        nonce: "nonexistent",
        request_path: "/api/v1/agent/chat",
        request_method: "POST",
        token_id: "0x1",
        model: "claude-opus-4-6",
        max_tokens: 4096,
      }),
    ).rejects.toThrow(X402VerifyError)

    expect(failures).toHaveLength(1)
    expect(failures[0].reason).toBe("nonce_not_found")
  })

  it("hmac_invalid: tampered challenge → 402", async () => {
    const challenge = await setupChallenge(redis, SECRET)
    // Tamper by modifying stored challenge
    const tampered = { ...challenge, amount: "999999" }
    await redis.set(
      `x402:challenge:${challenge.nonce}`,
      JSON.stringify(tampered),
      "EX", 300,
    )

    const rpcPool = createMockRpcPool({ receipt: null })
    const verifier = createVerifier(rpcPool)

    await expect(
      verifier.verify({
        tx_hash: TX_HASH,
        nonce: challenge.nonce,
        request_path: "/api/v1/agent/chat",
        request_method: "POST",
        token_id: "0x1",
        model: "claude-opus-4-6",
        max_tokens: 4096,
      }),
    ).rejects.toThrow("HMAC verification failed")

    expect(failures[0].reason).toBe("hmac_invalid")
  })

  it("binding_mismatch: different request params → 402", async () => {
    const challenge = await setupChallenge(redis, SECRET)
    const transferLog = makeTransferLog(
      "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      WALLET,
      BigInt(challenge.amount),
    )

    const rpcPool = createMockRpcPool({
      receipt: { status: "success", blockNumber: 900n, logs: [transferLog] },
      blockNumber: 1000n,
    })

    const verifier = createVerifier(rpcPool)

    await expect(
      verifier.verify({
        tx_hash: TX_HASH,
        nonce: challenge.nonce,
        request_path: "/api/v1/agent/chat",
        request_method: "POST",
        token_id: "0x1",
        model: "claude-haiku-4-5", // different model!
        max_tokens: 4096,
      }),
    ).rejects.toThrow("binding mismatch")

    expect(failures[0].reason).toBe("binding_mismatch")
  })

  it("tx_reverted: failed transaction → 402", async () => {
    const challenge = await setupChallenge(redis, SECRET)

    const rpcPool = createMockRpcPool({
      receipt: { status: "reverted", blockNumber: 900n, logs: [] },
      blockNumber: 1000n,
    })

    const verifier = createVerifier(rpcPool)

    await expect(
      verifier.verify({
        tx_hash: TX_HASH,
        nonce: challenge.nonce,
        request_path: "/api/v1/agent/chat",
        request_method: "POST",
        token_id: "0x1",
        model: "claude-opus-4-6",
        max_tokens: 4096,
      }),
    ).rejects.toThrow("Transaction reverted")
  })

  it("pending: insufficient confirmations → 402", async () => {
    const challenge = await setupChallenge(redis, SECRET)
    const transferLog = makeTransferLog(
      "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      WALLET,
      BigInt(challenge.amount),
    )

    const rpcPool = createMockRpcPool({
      receipt: { status: "success", blockNumber: 995n, logs: [transferLog] },
      blockNumber: 1000n, // Only 5 confirmations
    })

    const verifier = createVerifier(rpcPool)

    try {
      await verifier.verify({
        tx_hash: TX_HASH,
        nonce: challenge.nonce,
        request_path: "/api/v1/agent/chat",
        request_method: "POST",
        token_id: "0x1",
        model: "claude-opus-4-6",
        max_tokens: 4096,
      })
      expect.fail("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(X402VerifyError)
      expect((err as X402VerifyError).code).toBe("pending")
    }
  })

  it("transfer_not_found: wrong recipient → 402", async () => {
    const challenge = await setupChallenge(redis, SECRET)
    // Transfer to wrong address
    const transferLog = makeTransferLog(
      "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      "0x0000000000000000000000000000000000000000", // wrong recipient
      BigInt(challenge.amount),
    )

    const rpcPool = createMockRpcPool({
      receipt: { status: "success", blockNumber: 900n, logs: [transferLog] },
      blockNumber: 1000n,
    })

    const verifier = createVerifier(rpcPool)

    await expect(
      verifier.verify({
        tx_hash: TX_HASH,
        nonce: challenge.nonce,
        request_path: "/api/v1/agent/chat",
        request_method: "POST",
        token_id: "0x1",
        model: "claude-opus-4-6",
        max_tokens: 4096,
      }),
    ).rejects.toThrow("No matching USDC Transfer")
  })

  it("transfer_not_found: wrong amount → 402", async () => {
    const challenge = await setupChallenge(redis, SECRET)
    // Transfer with wrong amount
    const transferLog = makeTransferLog(
      "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      WALLET,
      BigInt("1"), // wrong amount
    )

    const rpcPool = createMockRpcPool({
      receipt: { status: "success", blockNumber: 900n, logs: [transferLog] },
      blockNumber: 1000n,
    })

    const verifier = createVerifier(rpcPool)

    await expect(
      verifier.verify({
        tx_hash: TX_HASH,
        nonce: challenge.nonce,
        request_path: "/api/v1/agent/chat",
        request_method: "POST",
        token_id: "0x1",
        model: "claude-opus-4-6",
        max_tokens: 4096,
      }),
    ).rejects.toThrow("No matching USDC Transfer")
  })

  it("replay_detected: same tx_hash reused → 402", async () => {
    const challenge1 = await setupChallenge(redis, SECRET)
    const transferLog = makeTransferLog(
      "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      WALLET,
      BigInt(challenge1.amount),
    )

    const rpcPool = createMockRpcPool({
      receipt: { status: "success", blockNumber: 900n, logs: [transferLog] },
      blockNumber: 1000n,
    })

    const verifier = createVerifier(rpcPool)

    // First verification succeeds
    await verifier.verify({
      tx_hash: TX_HASH,
      nonce: challenge1.nonce,
      request_path: "/api/v1/agent/chat",
      request_method: "POST",
      token_id: "0x1",
      model: "claude-opus-4-6",
      max_tokens: 4096,
    })

    // Second verification with new challenge but same tx_hash
    const challenge2 = await setupChallenge(redis, SECRET)

    await expect(
      verifier.verify({
        tx_hash: TX_HASH, // same tx_hash!
        nonce: challenge2.nonce,
        request_path: "/api/v1/agent/chat",
        request_method: "POST",
        token_id: "0x1",
        model: "claude-opus-4-6",
        max_tokens: 4096,
      }),
    ).rejects.toThrow("Transaction already used")
  })

  it("rpc_unreachable: RPC failure → 503", async () => {
    const challenge = await setupChallenge(redis, SECRET)
    const rpcError = new Error("connection refused") as Error & { code: string }
    rpcError.code = "rpc_unreachable"

    const rpcPool = createMockRpcPool({ error: rpcError })
    const verifier = createVerifier(rpcPool)

    try {
      await verifier.verify({
        tx_hash: TX_HASH,
        nonce: challenge.nonce,
        request_path: "/api/v1/agent/chat",
        request_method: "POST",
        token_id: "0x1",
        model: "claude-opus-4-6",
        max_tokens: 4096,
      })
      expect.fail("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(X402VerifyError)
      expect((err as X402VerifyError).code).toBe("rpc_unreachable")
      expect((err as X402VerifyError).httpStatus).toBe(503)
    }

    expect(failures[0].reason).toBe("rpc_unreachable")
  })

  it("smart contract wallet: tx.from ≠ Transfer.from passes when payer not bound", async () => {
    const challenge = await setupChallenge(redis, SECRET)
    // Transfer from a smart contract wallet (different from tx.from)
    const transferLog = makeTransferLog(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", // contract wallet
      WALLET,
      BigInt(challenge.amount),
    )

    const rpcPool = createMockRpcPool({
      receipt: { status: "success", blockNumber: 900n, logs: [transferLog] },
      blockNumber: 1000n,
    })

    const verifier = createVerifier(rpcPool)
    const result = await verifier.verify({
      tx_hash: TX_HASH,
      nonce: challenge.nonce,
      request_path: "/api/v1/agent/chat",
      request_method: "POST",
      token_id: "0x1",
      model: "claude-opus-4-6",
      max_tokens: 4096,
    })

    expect(result.sender.toLowerCase()).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
  })

  it("HMAC rotation: challenge signed with old secret validates during grace", async () => {
    // Sign challenge with OLD secret
    const challenge = await setupChallenge(redis, SECRET_OLD)

    const transferLog = makeTransferLog(
      "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      WALLET,
      BigInt(challenge.amount),
    )

    const rpcPool = createMockRpcPool({
      receipt: { status: "success", blockNumber: 900n, logs: [transferLog] },
      blockNumber: 1000n,
    })

    // Verifier has current secret + previous secret for rotation
    const verifier = createVerifier(rpcPool, { secretPrevious: SECRET_OLD })

    const result = await verifier.verify({
      tx_hash: TX_HASH,
      nonce: challenge.nonce,
      request_path: "/api/v1/agent/chat",
      request_method: "POST",
      token_id: "0x1",
      model: "claude-opus-4-6",
      max_tokens: 4096,
    })

    expect(result.tx_hash).toBe(TX_HASH)
  })

  it("HMAC rotation: old secret fails when no previous secret configured", async () => {
    // Sign with old secret, but verifier only has current secret
    const challenge = await setupChallenge(redis, SECRET_OLD)

    const rpcPool = createMockRpcPool({ receipt: null })
    const verifier = createVerifier(rpcPool) // no secretPrevious

    await expect(
      verifier.verify({
        tx_hash: TX_HASH,
        nonce: challenge.nonce,
        request_path: "/api/v1/agent/chat",
        request_method: "POST",
        token_id: "0x1",
        model: "claude-opus-4-6",
        max_tokens: 4096,
      }),
    ).rejects.toThrow("HMAC verification failed")
  })

  it("path_mismatch: different request path → 402", async () => {
    const challenge = await setupChallenge(redis, SECRET)
    const rpcPool = createMockRpcPool({ receipt: null })
    const verifier = createVerifier(rpcPool)

    await expect(
      verifier.verify({
        tx_hash: TX_HASH,
        nonce: challenge.nonce,
        request_path: "/api/v1/different/path", // wrong path
        request_method: "POST",
        token_id: "0x1",
        model: "claude-opus-4-6",
        max_tokens: 4096,
      }),
    ).rejects.toThrow("path/method mismatch")
  })
})
