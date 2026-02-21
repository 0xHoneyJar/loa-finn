// src/gateway/time-provider.ts — TimeProvider Abstraction (Bridge medium-4, Sprint 3 T3.1)
//
// Injectable time source for clock skew monitoring and testing.
// Default uses Date.now(). Mock implementations enable deterministic testing.
//
// Wire into SIWE auth, x402 receipt verifier, and consumption TTL checks.

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface TimeProvider {
  /** Get current time in Unix milliseconds */
  now(): number
  /** Get current time in Unix seconds (convenience) */
  nowSeconds(): number
}

// ---------------------------------------------------------------------------
// Default Implementation (system clock)
// ---------------------------------------------------------------------------

export class SystemTimeProvider implements TimeProvider {
  now(): number {
    return Date.now()
  }

  nowSeconds(): number {
    return Math.floor(Date.now() / 1000)
  }
}

// ---------------------------------------------------------------------------
// Mock Implementation (deterministic testing)
// ---------------------------------------------------------------------------

export class MockTimeProvider implements TimeProvider {
  private _nowMs: number

  constructor(initialMs: number = Date.now()) {
    this._nowMs = initialMs
  }

  now(): number {
    return this._nowMs
  }

  nowSeconds(): number {
    return Math.floor(this._nowMs / 1000)
  }

  /** Advance time by milliseconds */
  advance(ms: number): void {
    this._nowMs += ms
  }

  /** Set to a specific timestamp */
  set(ms: number): void {
    this._nowMs = ms
  }
}

// ---------------------------------------------------------------------------
// Clock Drift Monitor
// ---------------------------------------------------------------------------

export interface ClockDriftConfig {
  /** Maximum acceptable drift in milliseconds (default: 1000) */
  maxDriftMs?: number
  /** Callback when drift is detected */
  onDrift?: (driftMs: number) => void
}

export interface ClockDriftResult {
  driftMs: number
  withinTolerance: boolean
  referenceMs: number
  systemMs: number
}

/**
 * Check clock drift against a reference time source.
 * In production, reference would come from an NTP-synchronized peer
 * or HTTP Date header from a trusted service.
 *
 * Returns drift measurement. Logs warning if drift > threshold.
 *
 * Bridge iteration 2, finding 003: Wire into auth boundaries:
 * - SIWE auth: compare message.issuedAt against server time
 * - x402 verify: compare auth.valid_before against server time
 * - Credit consumption: compare reservation TTL against server time
 * TODO: Add startup drift check against trusted time source.
 */
export function measureClockDrift(
  referenceTimeMs: number,
  config: ClockDriftConfig = {},
): ClockDriftResult {
  const maxDriftMs = config.maxDriftMs ?? 1000
  const systemMs = Date.now()
  const driftMs = Math.abs(systemMs - referenceTimeMs)
  const withinTolerance = driftMs <= maxDriftMs

  if (!withinTolerance) {
    config.onDrift?.(driftMs)
  }

  return {
    driftMs,
    withinTolerance,
    referenceMs: referenceTimeMs,
    systemMs,
  }
}

// ---------------------------------------------------------------------------
// Singleton (default provider)
// ---------------------------------------------------------------------------

/** Default system time provider. Replace via DI for testing. */
export const defaultTimeProvider: TimeProvider = new SystemTimeProvider()
