// tests/fixtures/anvil-chain-profile.ts — Deterministic Test Chain Config (T-3.10)
//
// Provides deterministic addresses and keys for x402 settlement tests.
// In CI: Anvil forks Base at this config. In unit tests: used as constants.

export const ANVIL_CHAIN_PROFILE = {
  /** Base chain ID */
  chainId: 8453,

  /** Anvil RPC URL (local fork) */
  rpcUrl: "http://127.0.0.1:8545",

  /** USDC contract on Base (real address — Anvil fork preserves it) */
  usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",

  /** Deterministic merchant address (Anvil account #0) */
  merchantAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",

  /** Relayer private key (Anvil account #1 — funded with 10000 ETH) */
  relayerPrivateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",

  /** Relayer address derived from relayer private key */
  relayerAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",

  /** Test payer address (Anvil account #2) */
  payerAddress: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",

  /** Test payer private key (Anvil account #2) */
  payerPrivateKey: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
} as const

/**
 * Build a test EIP-3009 authorization for settlement tests.
 */
export function buildTestAuthorization(overrides?: {
  from?: string
  to?: string
  value?: string
  nonce?: string
  validAfter?: number
  validBefore?: number
}) {
  const now = Math.floor(Date.now() / 1000)
  return {
    from: overrides?.from ?? ANVIL_CHAIN_PROFILE.payerAddress,
    to: overrides?.to ?? ANVIL_CHAIN_PROFILE.merchantAddress,
    value: overrides?.value ?? "100000", // 0.10 USDC
    valid_after: overrides?.validAfter ?? now - 60,
    valid_before: overrides?.validBefore ?? now + 300,
    nonce: overrides?.nonce ?? `0x${Date.now().toString(16).padStart(64, "0")}`,
    v: 27,
    r: "0x" + "ab".repeat(32),
    s: "0x" + "cd".repeat(32),
  }
}
