# Hounfour Compatibility Matrix

Single source of truth for which `@0xhoneyjar/loa-hounfour` contract versions
loa-finn supports (#205, #211, #232, #235). Enforced by
`tests/finn/hounfour/compatibility-matrix.test.ts`, which fails when the
installed package, the `package.json` ref, the runtime `CONTRACT_VERSION`,
or this document drift from each other.

## Current state

| Surface | Value | Source |
|---------|-------|--------|
| Pinned package ref | `github:0xHoneyJar/loa-hounfour#v8.3.1` | `package.json` dependencies |
| Installed contract version | `8.3.1` | `node_modules/@0xhoneyjar/loa-hounfour` |
| Runtime `CONTRACT_VERSION` | `8.3.0` (known upstream quirk: the v8.3.1 tag ships a patch-lagged constant; parity enforced at major.minor) | `@0xhoneyjar/loa-hounfour` export |
| Finn minimum supported peer | `7.0.0` | `src/hounfour/protocol-handshake.ts` (`FINN_MIN_SUPPORTED`) |
| Supported range | `>=7.0.0 <9.0.0` | Hounfour semver policy: MAJOR = breaking, MINOR = additive |

## Matrix

| Hounfour line | Finn support | Notes |
|---------------|--------------|-------|
| 7.x | Supported (compatibility floor) | Peer handshake accepts 7.0.0+ |
| 8.0 – 8.3 | Supported, 8.3.1 pinned | Version finn is built and tested against |
| 8.4 – 8.7 | Expected-compatible (additive minors), not yet consumed | Known upstream lag — see "Version lag" below |
| 9.x | Unsupported until reviewed | MAJOR bump = breaking contract changes; requires a deliberate upgrade pass |

## Version lag policy (#232)

Hounfour publishes additive MINOR releases faster than finn consumes them
(upstream is at 8.7.x while finn pins 8.3.1). This lag is deliberate, not
drift, as long as:

1. The pin is a full tag (`#vX.Y.Z`), never a branch.
2. The handshake (`src/hounfour/protocol-handshake.ts`) treats newer additive
   minors from peers as compatible via feature detection.
3. Upgrades happen as their own reviewed change with the full validation
   suite as evidence, updating the pin, this document, and the matrix test
   together.

## Update procedure

1. Bump the `package.json` ref to the new tag and `pnpm install`.
2. Update the "Current state" table above.
3. Run `pnpm run typecheck` and the full validation suite (`pnpm run test:all`).
4. The matrix test will fail until the doc and pin agree.
