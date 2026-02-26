// tests/finn/goodhart/transport-factory.test.ts — Transport Factory Tests (T-1.1, cycle-036)

import { describe, it, expect } from "vitest"
import { createDixieTransport } from "../../../src/hounfour/goodhart/transport-factory.js"
import { DixieStubTransport, DixieHttpTransport } from "../../../src/hounfour/goodhart/dixie-transport.js"

describe("createDixieTransport", () => {
  it("returns DixieStubTransport when baseUrl is undefined", () => {
    const transport = createDixieTransport()
    expect(transport).toBeInstanceOf(DixieStubTransport)
  })

  it("returns DixieStubTransport when baseUrl is empty string", () => {
    const transport = createDixieTransport("")
    expect(transport).toBeInstanceOf(DixieStubTransport)
  })

  it('returns DixieStubTransport when baseUrl is "stub"', () => {
    const transport = createDixieTransport("stub")
    expect(transport).toBeInstanceOf(DixieStubTransport)
  })

  it("returns DixieHttpTransport for a valid URL", () => {
    const transport = createDixieTransport("http://localhost:3000")
    expect(transport).toBeInstanceOf(DixieHttpTransport)
  })
})
