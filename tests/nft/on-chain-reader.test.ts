// tests/nft/on-chain-reader.test.ts — On-Chain Signal Reader Tests (Sprint 5 T5.1)

import { describe, it, expect, vi } from "vitest"
import { OnChainReader, OnChainReaderError, deriveTarotFromMolecule } from "../../src/nft/on-chain-reader.js"
import type { RpcPool } from "../../src/x402/rpc-pool.js"
import type { SignalSnapshot } from "../../src/nft/signal-types.js"

// ---------------------------------------------------------------------------
// Mock RpcPool
// ---------------------------------------------------------------------------

function createMockRpcPool(handlers: {
  tokenURI?: (tokenId: bigint) => string
  ownerOf?: (tokenId: bigint) => string
}): RpcPool {
  return {
    async execute<T>(fn: (client: unknown) => Promise<T>): Promise<T> {
      const mockClient = {
        readContract: async (args: { functionName: string; args: unknown[] }) => {
          const tokenIdBigInt = (args.args as bigint[])[0]
          if (args.functionName === "tokenURI") {
            if (!handlers.tokenURI) throw new Error("tokenURI not mocked")
            return handlers.tokenURI(tokenIdBigInt)
          }
          if (args.functionName === "ownerOf") {
            if (!handlers.ownerOf) throw new Error("ownerOf not mocked")
            return handlers.ownerOf(tokenIdBigInt)
          }
          throw new Error(`Unknown function: ${args.functionName}`)
        },
      }
      return fn(mockClient) as Promise<T>
    },
    getHealth: () => [],
  } as unknown as RpcPool
}

// ---------------------------------------------------------------------------
// Valid test metadata
// ---------------------------------------------------------------------------

const VALID_METADATA = {
  name: "Finn #42",
  description: "A test NFT",
  image: "https://example.com/42.png",
  attributes: [
    { trait_type: "archetype", value: "freetekno" },
    { trait_type: "ancestor", value: "Tesla" },
    { trait_type: "birthday", value: "1352-06-15" },
    { trait_type: "molecule", value: "DMT" },
    { trait_type: "swag_rank", value: "S" },
    { trait_type: "swag_score", value: 75 },
    { trait_type: "sun_sign", value: "aries" },
    { trait_type: "moon_sign", value: "cancer" },
    { trait_type: "ascending_sign", value: "leo" },
  ],
}

const MOCK_OWNER = "0x1234567890abcdef1234567890abcdef12345678"
const MOCK_CONTRACT = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"

function createMockFetch(responseData: unknown, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => responseData,
  }) as unknown as typeof fetch
}

// ---------------------------------------------------------------------------
// T5.1: On-chain reader construction
// ---------------------------------------------------------------------------

describe("T5.1: OnChainReader construction", () => {
  it("constructs with valid config", () => {
    const pool = createMockRpcPool({})
    const reader = new OnChainReader({
      rpcPool: pool,
      contractAddress: MOCK_CONTRACT,
    })
    expect(reader).toBeDefined()
  })

  it("throws on invalid contract address", () => {
    const pool = createMockRpcPool({})
    expect(() => new OnChainReader({
      rpcPool: pool,
      contractAddress: "not-an-address",
    })).toThrow(OnChainReaderError)
  })

  it("accepts custom IPFS gateway", () => {
    const pool = createMockRpcPool({})
    const reader = new OnChainReader({
      rpcPool: pool,
      contractAddress: MOCK_CONTRACT,
      ipfsGateway: "https://gateway.pinata.cloud/ipfs/",
    })
    expect(reader).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// T5.1: readOwner
// ---------------------------------------------------------------------------

describe("T5.1: readOwner", () => {
  it("reads owner address from contract", async () => {
    const pool = createMockRpcPool({
      ownerOf: () => MOCK_OWNER,
    })
    const reader = new OnChainReader({
      rpcPool: pool,
      contractAddress: MOCK_CONTRACT,
    })

    const owner = await reader.readOwner("42")
    expect(owner).toBe(MOCK_OWNER.toLowerCase())
  })

  it("throws CONTRACT_READ_FAILED on RPC error", async () => {
    const pool = createMockRpcPool({
      ownerOf: () => { throw new Error("RPC timeout") },
    })
    const reader = new OnChainReader({
      rpcPool: pool,
      contractAddress: MOCK_CONTRACT,
    })

    await expect(reader.readOwner("42")).rejects.toThrow(OnChainReaderError)
    await expect(reader.readOwner("42")).rejects.toThrow("ownerOf(42) failed")
  })
})

// ---------------------------------------------------------------------------
// T5.1: readTokenURI
// ---------------------------------------------------------------------------

describe("T5.1: readTokenURI", () => {
  it("reads tokenURI from contract", async () => {
    const pool = createMockRpcPool({
      tokenURI: () => "https://api.example.com/token/42",
    })
    const reader = new OnChainReader({
      rpcPool: pool,
      contractAddress: MOCK_CONTRACT,
    })

    const uri = await reader.readTokenURI("42")
    expect(uri).toBe("https://api.example.com/token/42")
  })

  it("handles IPFS URIs", async () => {
    const pool = createMockRpcPool({
      tokenURI: () => "ipfs://QmTest123/42.json",
    })
    const reader = new OnChainReader({
      rpcPool: pool,
      contractAddress: MOCK_CONTRACT,
    })

    const uri = await reader.readTokenURI("42")
    expect(uri).toBe("ipfs://QmTest123/42.json")
  })
})

// ---------------------------------------------------------------------------
// T5.1: fetchMetadata
// ---------------------------------------------------------------------------

describe("T5.1: fetchMetadata", () => {
  it("fetches HTTP metadata", async () => {
    const mockFetch = createMockFetch(VALID_METADATA)
    const pool = createMockRpcPool({})
    const reader = new OnChainReader({
      rpcPool: pool,
      contractAddress: MOCK_CONTRACT,
      fetchFn: mockFetch,
    })

    const metadata = await reader.fetchMetadata("https://api.example.com/token/42")
    expect(metadata.name).toBe("Finn #42")
    expect(metadata.attributes).toHaveLength(9)
  })

  it("resolves IPFS URIs to HTTP gateway", async () => {
    const mockFetch = createMockFetch(VALID_METADATA)
    const pool = createMockRpcPool({})
    const reader = new OnChainReader({
      rpcPool: pool,
      contractAddress: MOCK_CONTRACT,
      fetchFn: mockFetch,
      ipfsGateway: "https://ipfs.io/ipfs/",
    })

    await reader.fetchMetadata("ipfs://QmTest123/42.json")
    expect(mockFetch).toHaveBeenCalledWith(
      "https://ipfs.io/ipfs/QmTest123/42.json",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it("parses data: URI with base64 encoding", async () => {
    const pool = createMockRpcPool({})
    const reader = new OnChainReader({
      rpcPool: pool,
      contractAddress: MOCK_CONTRACT,
    })

    const encoded = Buffer.from(JSON.stringify(VALID_METADATA)).toString("base64")
    const dataUri = `data:application/json;base64,${encoded}`

    const metadata = await reader.fetchMetadata(dataUri)
    expect(metadata.name).toBe("Finn #42")
  })

  it("parses data: URI with plain JSON", async () => {
    const pool = createMockRpcPool({})
    const reader = new OnChainReader({
      rpcPool: pool,
      contractAddress: MOCK_CONTRACT,
    })

    const jsonStr = encodeURIComponent(JSON.stringify(VALID_METADATA))
    const dataUri = `data:application/json,${jsonStr}`

    const metadata = await reader.fetchMetadata(dataUri)
    expect(metadata.name).toBe("Finn #42")
  })

  it("throws METADATA_FETCH_FAILED on HTTP error", async () => {
    const mockFetch = createMockFetch({}, 404)
    const pool = createMockRpcPool({})
    const reader = new OnChainReader({
      rpcPool: pool,
      contractAddress: MOCK_CONTRACT,
      fetchFn: mockFetch,
    })

    await expect(reader.fetchMetadata("https://api.example.com/404")).rejects.toThrow("Failed to fetch metadata")
  })
})

// ---------------------------------------------------------------------------
// T5.1: parseMetadataToSnapshot
// ---------------------------------------------------------------------------

describe("T5.1: parseMetadataToSnapshot", () => {
  const pool = createMockRpcPool({})
  const reader = new OnChainReader({
    rpcPool: pool,
    contractAddress: MOCK_CONTRACT,
  })

  it("parses valid metadata into SignalSnapshot", () => {
    const snapshot = reader.parseMetadataToSnapshot(VALID_METADATA, "42")

    expect(snapshot.archetype).toBe("freetekno")
    expect(snapshot.ancestor).toBe("Tesla")
    expect(snapshot.birthday).toBe("1352-06-15")
    expect(snapshot.era).toBe("medieval")
    expect(snapshot.molecule).toBe("DMT")
    expect(snapshot.swag_rank).toBe("S")
    expect(snapshot.swag_score).toBe(75)
    expect(snapshot.sun_sign).toBe("aries")
    expect(snapshot.moon_sign).toBe("cancer")
    expect(snapshot.ascending_sign).toBe("leo")
    expect(snapshot.tarot).toBeDefined()
    expect(snapshot.element).toBeDefined()
  })

  it("derives era=medieval for year 1352", () => {
    const snapshot = reader.parseMetadataToSnapshot(VALID_METADATA, "42")
    expect(snapshot.era).toBe("medieval")
  })

  it("derives era=contemporary for modern dates", () => {
    const modernMetadata = {
      ...VALID_METADATA,
      attributes: VALID_METADATA.attributes.map((a) =>
        a.trait_type === "birthday" ? { ...a, value: "1985-03-21" } : a,
      ),
    }
    const snapshot = reader.parseMetadataToSnapshot(modernMetadata, "42")
    expect(snapshot.era).toBe("contemporary")
  })

  it("derives era=ancient for negative years", () => {
    const ancientMetadata = {
      ...VALID_METADATA,
      attributes: VALID_METADATA.attributes.map((a) =>
        a.trait_type === "birthday" ? { ...a, value: "-5000-01-01" } : a,
      ),
    }
    const snapshot = reader.parseMetadataToSnapshot(ancientMetadata, "42")
    expect(snapshot.era).toBe("ancient")
  })

  it("throws on missing attributes array", () => {
    expect(() => reader.parseMetadataToSnapshot({}, "42")).toThrow("metadata has no attributes")
  })

  it("throws on invalid archetype", () => {
    const badMetadata = {
      attributes: VALID_METADATA.attributes.map((a) =>
        a.trait_type === "archetype" ? { ...a, value: "invalid" } : a,
      ),
    }
    expect(() => reader.parseMetadataToSnapshot(badMetadata, "42")).toThrow("invalid archetype")
  })

  it("throws on missing required attribute", () => {
    const incomplete = {
      attributes: [{ trait_type: "archetype", value: "freetekno" }],
    }
    expect(() => reader.parseMetadataToSnapshot(incomplete, "42")).toThrow("missing required attribute")
  })

  it("throws on invalid zodiac sign", () => {
    const badZodiac = {
      attributes: VALID_METADATA.attributes.map((a) =>
        a.trait_type === "sun_sign" ? { ...a, value: "not_a_sign" } : a,
      ),
    }
    expect(() => reader.parseMetadataToSnapshot(badZodiac, "42")).toThrow("invalid sun_sign")
  })
})

// ---------------------------------------------------------------------------
// T5.1: readSignals (integration)
// ---------------------------------------------------------------------------

describe("T5.1: readSignals", () => {
  it("reads tokenURI + ownerOf in parallel and returns SignalSnapshot", async () => {
    const mockFetch = createMockFetch(VALID_METADATA)
    const pool = createMockRpcPool({
      tokenURI: () => "https://api.example.com/token/42",
      ownerOf: () => MOCK_OWNER,
    })
    const reader = new OnChainReader({
      rpcPool: pool,
      contractAddress: MOCK_CONTRACT,
      fetchFn: mockFetch,
    })

    const { snapshot, owner } = await reader.readSignals("42")

    expect(owner).toBe(MOCK_OWNER.toLowerCase())
    expect(snapshot.archetype).toBe("freetekno")
    expect(snapshot.ancestor).toBe("Tesla")
    expect(snapshot.era).toBe("medieval")
  })
})

// ---------------------------------------------------------------------------
// T5.1: deriveTarotFromMolecule
// ---------------------------------------------------------------------------

describe("T5.1: deriveTarotFromMolecule", () => {
  it("produces a valid TarotCard", () => {
    const card = deriveTarotFromMolecule("DMT")
    expect(card.number).toBeGreaterThanOrEqual(0)
    expect(card.number).toBeLessThan(78)
    expect(card.suit).toBeDefined()
    expect(card.element).toBeDefined()
  })

  it("is deterministic (same input → same output)", () => {
    const card1 = deriveTarotFromMolecule("DMT")
    const card2 = deriveTarotFromMolecule("DMT")
    expect(card1).toEqual(card2)
  })

  it("produces different cards for different molecules", () => {
    const dmt = deriveTarotFromMolecule("DMT")
    const lsd = deriveTarotFromMolecule("LSD")
    // Different molecules should produce different card numbers (statistically)
    // This is a probabilistic test but with good hash distribution
    expect(dmt.number !== lsd.number || dmt.suit !== lsd.suit).toBe(true)
  })

  it("assigns correct element per suit", () => {
    // Test with a molecule that lands on a minor arcana card
    const card = deriveTarotFromMolecule("Psilocybin")
    if (card.suit === "wands") expect(card.element).toBe("fire")
    if (card.suit === "cups") expect(card.element).toBe("water")
    if (card.suit === "swords") expect(card.element).toBe("air")
    if (card.suit === "pentacles") expect(card.element).toBe("earth")
    if (card.suit === "major") expect(card.element).toBe("fire")
  })
})
