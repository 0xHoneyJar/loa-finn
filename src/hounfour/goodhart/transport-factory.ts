// src/hounfour/goodhart/transport-factory.ts — Transport Factory (SDD §3.2, cycle-036 T-1.1)
//
// Factory for DixieTransport instances. Returns DixieStubTransport when baseUrl
// is undefined, empty, or "stub"; DixieHttpTransport otherwise.

import { DixieStubTransport, DixieHttpTransport } from "./dixie-transport.js"
import type { DixieTransport, DixieHttpConfig } from "./dixie-transport.js"

/**
 * Create a DixieTransport from a base URL.
 *
 * - undefined / "" / "stub" → DixieStubTransport (zero overhead, null returns)
 * - Any other URL → DixieHttpTransport (HTTP with circuit breaker + DNS warming)
 */
export function createDixieTransport(
  baseUrl?: string,
  config?: Omit<DixieHttpConfig, "baseUrl">,
): DixieTransport {
  if (!baseUrl || baseUrl === "" || baseUrl === "stub") {
    return new DixieStubTransport()
  }
  return new DixieHttpTransport({ baseUrl, ...config })
}
