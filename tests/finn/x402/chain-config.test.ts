// tests/finn/x402/chain-config.test.ts — Chain Config Unit Tests (T-4.4)
//
// Tests for CHAIN_CONFIGS, resolveChainConfig(), and env var overrides.

import { describe, it, expect, afterEach } from "vitest"
import { CHAIN_CONFIGS, resolveChainConfig } from "../../../src/x402/types.js"

describe("CHAIN_CONFIGS", () => {
  it("contains Base mainnet (8453)", () => {
    const config = CHAIN_CONFIGS[8453]
    expect(config).toBeDefined()
    expect(config.chainId).toBe(8453)
    expect(config.name).toBe("Base")
    expect(config.usdcAddress).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
    expect(config.testnet).toBe(false)
  })

  it("contains Base Sepolia (84532)", () => {
    const config = CHAIN_CONFIGS[84532]
    expect(config).toBeDefined()
    expect(config.chainId).toBe(84532)
    expect(config.name).toBe("Base Sepolia")
    expect(config.usdcAddress).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e")
    expect(config.testnet).toBe(true)
  })

  it("does not contain unknown chains", () => {
    expect(CHAIN_CONFIGS[1]).toBeUndefined()
    expect(CHAIN_CONFIGS[137]).toBeUndefined()
    expect(CHAIN_CONFIGS[0]).toBeUndefined()
  })
})

describe("resolveChainConfig", () => {
  const origChainId = process.env.X402_CHAIN_ID
  const origUsdcAddr = process.env.X402_USDC_ADDRESS

  afterEach(() => {
    // Restore original env
    if (origChainId !== undefined) {
      process.env.X402_CHAIN_ID = origChainId
    } else {
      delete process.env.X402_CHAIN_ID
    }
    if (origUsdcAddr !== undefined) {
      process.env.X402_USDC_ADDRESS = origUsdcAddr
    } else {
      delete process.env.X402_USDC_ADDRESS
    }
  })

  it("defaults to Base mainnet (8453) when no env var", () => {
    delete process.env.X402_CHAIN_ID
    delete process.env.X402_USDC_ADDRESS
    const config = resolveChainConfig()
    expect(config.chainId).toBe(8453)
    expect(config.name).toBe("Base")
    expect(config.testnet).toBe(false)
  })

  it("resolves to Sepolia when X402_CHAIN_ID=84532", () => {
    process.env.X402_CHAIN_ID = "84532"
    delete process.env.X402_USDC_ADDRESS
    const config = resolveChainConfig()
    expect(config.chainId).toBe(84532)
    expect(config.name).toBe("Base Sepolia")
    expect(config.testnet).toBe(true)
    expect(config.usdcAddress).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e")
  })

  it("throws for unknown chain ID", () => {
    process.env.X402_CHAIN_ID = "99999"
    expect(() => resolveChainConfig()).toThrow("Unknown chain ID 99999")
  })

  it("overrides USDC address with X402_USDC_ADDRESS", () => {
    delete process.env.X402_CHAIN_ID
    process.env.X402_USDC_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678"
    const config = resolveChainConfig()
    expect(config.chainId).toBe(8453) // Still mainnet
    expect(config.usdcAddress).toBe("0x1234567890abcdef1234567890abcdef12345678")
  })

  it("combines chain ID and USDC address overrides", () => {
    process.env.X402_CHAIN_ID = "84532"
    process.env.X402_USDC_ADDRESS = "0xaabbccddee11223344556677889900aabbccddee"
    const config = resolveChainConfig()
    expect(config.chainId).toBe(84532)
    expect(config.name).toBe("Base Sepolia")
    expect(config.usdcAddress).toBe("0xaabbccddee11223344556677889900aabbccddee")
  })

  it("throws for malformed X402_USDC_ADDRESS", () => {
    delete process.env.X402_CHAIN_ID
    process.env.X402_USDC_ADDRESS = "0xNotAValidAddress"
    expect(() => resolveChainConfig()).toThrow("Invalid X402_USDC_ADDRESS")
  })

  it("handles non-numeric X402_CHAIN_ID gracefully", () => {
    process.env.X402_CHAIN_ID = "not-a-number"
    // parseInt returns NaN, which won't be in CHAIN_CONFIGS
    expect(() => resolveChainConfig()).toThrow("Unknown chain ID")
  })
})
