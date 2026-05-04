#!/usr/bin/env npx tsx
// scripts/generate-consumer-contract.ts — T-4.1
//
// Introspects src/hounfour/protocol-types.ts actual exports and generates
// the FINN_CONTRACT symbols array. Filters out NON_CONTRACT_EXPORTS to
// produce only the minimum required runtime surface.
//
// Usage: npx tsx scripts/generate-consumer-contract.ts

import * as ProtocolTypes from "../src/hounfour/protocol-types.js"
import { NON_CONTRACT_EXPORTS } from "../src/boot/consumer-contract-check.js"

const allExports = Object.keys(ProtocolTypes).sort()

const contractSymbols = allExports.filter(
  (sym) => !NON_CONTRACT_EXPORTS.has(sym),
)

const nonContractSymbols = allExports.filter((sym) =>
  NON_CONTRACT_EXPORTS.has(sym),
)

console.log("// === FINN_CONTRACT symbol list (auto-generated) ===")
console.log(`// Total barrel exports: ${allExports.length}`)
console.log(`// Contract symbols: ${contractSymbols.length}`)
console.log(`// Non-contract (filtered): ${nonContractSymbols.length}`)
console.log()
console.log("symbols: [")
for (const sym of contractSymbols) {
  console.log(`  "${sym}",`)
}
console.log("]")
console.log()
console.log("// === NON_CONTRACT_EXPORTS (filtered out) ===")
for (const sym of nonContractSymbols) {
  console.log(`//   ${sym}`)
}

// Verify: check for barrel exports not in either list (would indicate
// NON_CONTRACT_EXPORTS needs updating)
const uncategorized = allExports.filter(
  (sym) =>
    !contractSymbols.includes(sym) && !NON_CONTRACT_EXPORTS.has(sym),
)
if (uncategorized.length > 0) {
  console.error(
    `\nWARNING: ${uncategorized.length} uncategorized symbols:`,
  )
  for (const sym of uncategorized) {
    console.error(`  ${sym}`)
  }
  process.exit(1)
}
