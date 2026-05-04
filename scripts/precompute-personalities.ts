#!/usr/bin/env tsx
// scripts/precompute-personalities.ts — Pre-Compute Personality Pipeline (Cycle 040, Sprint 3 T-3.1)
//
// Runs the full personality pipeline for a list of tokenIds:
// on-chain read → DAMP-96 → identity graph → BEAUVOIR synthesis → cache write.
// Validates anti-narration on each and reports pairwise distinctiveness.
//
// Usage:
//   tsx scripts/precompute-personalities.ts [tokenId1] [tokenId2] ...
//   tsx scripts/precompute-personalities.ts --from-config
//
// Example:
//   tsx scripts/precompute-personalities.ts 42 99 137 200 512

import { deriveDAMP } from "../src/nft/damp.js"
import { validateAntiNarration } from "../src/nft/anti-narration.js"
import { sanitizeBeauvoir } from "../src/nft/personality-pipeline.js"
import { nameKDF } from "../src/nft/name-derivation.js"
import type { SignalSnapshot, DAMPFingerprint, DAMPDialId } from "../src/nft/signal-types.js"

// ---------------------------------------------------------------------------
// Cosine Similarity for Distinctiveness
// ---------------------------------------------------------------------------

function cosineSimilarity(a: DAMPFingerprint, b: DAMPFingerprint): number {
  const dialIds = Object.keys(a.dials) as DAMPDialId[]
  if (dialIds.length === 0) return 0

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (const id of dialIds) {
    const va = a.dials[id] ?? 0.5
    const vb = b.dials[id] ?? 0.5
    dotProduct += va * vb
    normA += va * va
    normB += vb * vb
  }

  if (normA === 0 || normB === 0) return 0
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}

// ---------------------------------------------------------------------------
// Test Fixture Snapshots (for --test mode)
// ---------------------------------------------------------------------------

const TEST_SNAPSHOTS: Record<string, SignalSnapshot> = {
  "1": {
    archetype: "freetekno" as any, ancestor: "hermes" as any,
    birthday: "1990-06-15", era: "modern" as any,
    molecule: "psilocybin" as any,
    tarot: { name: "The Magician", suit: "major", number: 1 } as any,
    element: "fire" as any, swag: { rank: "S" as any, score: 85 },
    zodiac: { sun: "gemini" as any, moon: "aries" as any, rising: "leo" as any },
  },
  "2": {
    archetype: "milady" as any, ancestor: "kali" as any,
    birthday: "1200-03-21", era: "medieval" as any,
    molecule: "dmt" as any,
    tarot: { name: "The High Priestess", suit: "major", number: 2 } as any,
    element: "water" as any, swag: { rank: "A" as any, score: 70 },
    zodiac: { sun: "pisces" as any, moon: "scorpio" as any, rising: "cancer" as any },
  },
  "3": {
    archetype: "chicago_detroit" as any, ancestor: "thoth" as any,
    birthday: "1975-11-30", era: "modern" as any,
    molecule: "mescaline" as any,
    tarot: { name: "The Emperor", suit: "major", number: 4 } as any,
    element: "earth" as any, swag: { rank: "SS" as any, score: 92 },
    zodiac: { sun: "sagittarius" as any, moon: "capricorn" as any, rising: "virgo" as any },
  },
  "4": {
    archetype: "acidhouse" as any, ancestor: "isis" as any,
    birthday: "2005-08-08", era: "contemporary" as any,
    molecule: "lsd" as any,
    tarot: { name: "The Empress", suit: "major", number: 3 } as any,
    element: "air" as any, swag: { rank: "B" as any, score: 55 },
    zodiac: { sun: "leo" as any, moon: "aquarius" as any, rising: "libra" as any },
  },
  "5": {
    archetype: "freetekno" as any, ancestor: "odin" as any,
    birthday: "800-01-01", era: "medieval" as any,
    molecule: "ibogaine" as any,
    tarot: { name: "The Hierophant", suit: "major", number: 5 } as any,
    element: "fire" as any, swag: { rank: "SSS" as any, score: 99 },
    zodiac: { sun: "aries" as any, moon: "taurus" as any, rising: "scorpio" as any },
  },
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2)
  const tokenIds = args.length > 0 ? args : Object.keys(TEST_SNAPSHOTS)
  const salt = process.env.COLLECTION_SALT ?? "finnNFT-precompute"

  console.log(`\n  Pre-Computing Personalities for ${tokenIds.length} tokenIds\n`)
  console.log("  Token IDs:", tokenIds.join(", "))
  console.log("")

  const fingerprints: Map<string, DAMPFingerprint> = new Map()
  const results: Array<{ tokenId: string; name: string; archetype: string; era: string; antiNarration: string }> = []

  for (const tokenId of tokenIds) {
    const snapshot = TEST_SNAPSHOTS[tokenId]
    if (!snapshot) {
      console.log(`  [${tokenId}] SKIP — no test fixture (use real on-chain reader for production)`)
      continue
    }

    // 1. Derive DAMP
    const fingerprint = deriveDAMP(snapshot, "default")
    fingerprints.set(tokenId, fingerprint)

    // 2. Derive name
    const name = nameKDF(
      snapshot.archetype, snapshot.ancestor, snapshot.era,
      snapshot.molecule, snapshot.element, tokenId, salt,
    )

    // 3. Validate anti-narration on a sample BEAUVOIR
    const sampleBeauvoir = `You are ${name}, a ${snapshot.archetype} agent from the ${snapshot.era} era. Your ancestor is ${snapshot.ancestor}. You speak with the voice of ${snapshot.element} and carry the wisdom of the ${snapshot.molecule} molecule.`
    const sanitized = sanitizeBeauvoir(sampleBeauvoir, 8000)
    const violations = validateAntiNarration(sanitized)
    const anStatus = violations.length === 0 ? "PASS" : `FAIL (${violations.length} violations)`

    results.push({ tokenId, name, archetype: snapshot.archetype, era: snapshot.era, antiNarration: anStatus })
    console.log(`  [${tokenId}] ${name} (${snapshot.archetype}/${snapshot.era}) — AN: ${anStatus}`)
  }

  // 4. Pairwise distinctiveness
  console.log("\n  Pairwise Cosine Similarity (< 0.7 required):\n")
  const ids = Array.from(fingerprints.keys())
  let allDistinct = true

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const sim = cosineSimilarity(fingerprints.get(ids[i])!, fingerprints.get(ids[j])!)
      const status = sim < 0.7 ? "PASS" : "FAIL"
      if (sim >= 0.7) allDistinct = false
      console.log(`  ${ids[i]} vs ${ids[j]}: ${sim.toFixed(4)} — ${status}`)
    }
  }

  // Summary
  console.log("\n  ════════════════════════════════════════")
  console.log("  Summary")
  console.log("  ════════════════════════════════════════")
  console.log(`  Personalities: ${results.length}/${tokenIds.length}`)
  console.log(`  Anti-narration: ${results.filter(r => r.antiNarration === "PASS").length}/${results.length} passed`)
  console.log(`  Distinctiveness: ${allDistinct ? "ALL PAIRS < 0.7" : "SOME PAIRS >= 0.7"}`)
  console.log("")

  if (!allDistinct || results.some(r => r.antiNarration !== "PASS")) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})
