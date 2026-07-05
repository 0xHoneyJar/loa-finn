// Hounfour version compatibility parity (#205, #211, #232, #235).
//
// One source of truth: the package.json ref, the installed package, the
// runtime CONTRACT_VERSION, the handshake floor, and the compatibility
// matrix doc must all agree. Any single-surface bump fails here.
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { CONTRACT_VERSION, parseSemver } from "@0xhoneyjar/loa-hounfour"
import { FINN_MIN_SUPPORTED } from "../../../src/hounfour/protocol-handshake.js"

const repoRoot = resolve(import.meta.dirname ?? __dirname, "../../..")

const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf-8")) as {
  dependencies: Record<string, string>
}
const installed = JSON.parse(
  readFileSync(resolve(repoRoot, "node_modules/@0xhoneyjar/loa-hounfour/package.json"), "utf-8"),
) as { version: string }
const doc = readFileSync(resolve(repoRoot, "docs/hounfour-compatibility.md"), "utf-8")

const ref = pkg.dependencies["@0xhoneyjar/loa-hounfour"]
const pinMatch = /#v(\d+\.\d+\.\d+)$/.exec(ref)

describe("hounfour compatibility matrix", () => {
  it("package.json pins a full release tag, not a branch", () => {
    expect(pinMatch, `ref "${ref}" must end in #vX.Y.Z`).not.toBeNull()
  })

  it("installed package matches the pinned tag", () => {
    expect(installed.version).toBe(pinMatch![1])
  })

  it("runtime CONTRACT_VERSION matches the installed package at major.minor", () => {
    // Known upstream quirk (documented in the matrix): the v8.3.1 tag ships
    // CONTRACT_VERSION = "8.3.0" — the runtime constant can lag the package
    // version by a patch. Patch releases are non-breaking by policy, so
    // parity is enforced at major.minor; a silent MINOR/MAJOR mismatch
    // (the real contract-drift hazard from #232) still fails here.
    const runtime = parseSemver(CONTRACT_VERSION)!
    const packaged = parseSemver(installed.version)!
    expect(`${runtime.major}.${runtime.minor}`).toBe(`${packaged.major}.${packaged.minor}`)
  })

  it("installed version is inside the supported range [FINN_MIN_SUPPORTED, next major)", () => {
    const v = parseSemver(CONTRACT_VERSION)
    const floor = parseSemver(FINN_MIN_SUPPORTED)
    expect(v).not.toBeNull()
    expect(floor).not.toBeNull()
    expect(v!.major).toBeGreaterThanOrEqual(floor!.major)
    // MAJOR bumps are breaking per hounfour semver policy; crossing one
    // requires a deliberate upgrade pass (update matrix + this bound).
    expect(v!.major).toBeLessThan(9)
  })

  it("docs/hounfour-compatibility.md states the pinned and floor versions", () => {
    expect(doc).toContain(`#v${pinMatch![1]}`)
    expect(doc).toContain(`\`${pinMatch![1]}\``)
    expect(doc).toContain(`\`${FINN_MIN_SUPPORTED}\``)
  })
})
