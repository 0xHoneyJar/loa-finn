// src/credits/conversion.ts — Credit Deduction Service (SDD §3.3, Sprint 3 Task 3.1)
//
// Wraps existing Lua atomics (reserve-lua.ts) with CreditUnit conversion layer.
// Lua scripts operate in MicroUSD — this module converts before/after invocation.
// Rate freeze: CREDIT_UNITS_PER_USD captured at RESERVE time, used for COMMIT/RELEASE.

import type { BrandedMicroUSD as MicroUSD } from "@0xhoneyjar/loa-hounfour"
import type { CreditUnit } from "../hounfour/wire-boundary.js"
import {
  convertMicroUSDtoCreditUnit,
  serializeMicroUSD,
  serializeCreditUnit,
} from "../hounfour/wire-boundary.js"
import { atomicReserve, atomicCommit, atomicRelease, RESERVE_TTL_SECONDS } from "../billing/reserve-lua.js"
import { estimateReserveCost, computeActualCost, freezeRates } from "../billing/pricing.js"
import type { ExchangeRateSnapshot } from "../billing/types.js"
import type { RedisCommandClient } from "../hounfour/redis/client.js"

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class InsufficientCreditsError extends Error {
  public readonly httpStatus = 402

  constructor(
    public readonly balance_cu: string,
    public readonly estimated_cost_cu: string,
    public readonly deficit_cu: string,
  ) {
    super(`Insufficient credits: balance=${balance_cu} CU, cost=${estimated_cost_cu} CU, deficit=${deficit_cu} CU`)
    this.name = "InsufficientCreditsError"
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReserveCreditResult {
  estimatedCostMicro: MicroUSD
  estimatedCostCU: CreditUnit
  rateSnapshot: ExchangeRateSnapshot
}

export interface CommitCreditResult {
  actualCostMicro: MicroUSD
  actualCostCU: CreditUnit
  overageMicro: bigint
  overageCU: CreditUnit
}

export interface CreditDeductionDeps {
  redis: RedisCommandClient
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CreditDeductionService {
  private readonly redis: RedisCommandClient

  constructor(deps: CreditDeductionDeps) {
    this.redis = deps.redis
  }

  /**
   * Reserve credits for an inference request.
   *
   * Flow: pricing.estimateReserveCost → CU ceil → Lua atomicReserve (MicroUSD)
   *
   * On insufficient balance: throws InsufficientCreditsError with CU display values.
   */
  async reserveCredits(
    accountId: string,
    billingEntryId: string,
    model: string,
    inputTokens: number,
    maxTokens: number,
    rateSnapshotOverride?: ExchangeRateSnapshot,
  ): Promise<ReserveCreditResult> {
    // 1. Estimate cost in MicroUSD (ceil — user never under-reserved)
    const estimatedCostMicro = estimateReserveCost(model, inputTokens, maxTokens)

    // 2. Freeze rates at RESERVE time
    const rateSnapshot = rateSnapshotOverride ?? freezeRates()

    // 3. Convert to CU for display (ceil)
    const estimatedCostCU = convertMicroUSDtoCreditUnit(
      estimatedCostMicro,
      rateSnapshot.credit_units_per_usd,
      "ceil",
    )

    // 4. Atomic reserve in MicroUSD via Lua
    const result = await atomicReserve(
      this.redis,
      accountId,
      billingEntryId,
      serializeMicroUSD(estimatedCostMicro),
      Number(process.env.RESERVE_TTL_SECONDS ?? RESERVE_TTL_SECONDS),
    )

    if (!result.success && result.reason === "insufficient_balance") {
      // Read current balance for error response
      const balanceStr = await this.redis.get(`balance:${accountId}:value`) ?? "0"
      const balanceMicro = BigInt(balanceStr) as MicroUSD
      const balanceCU = convertMicroUSDtoCreditUnit(
        balanceMicro,
        rateSnapshot.credit_units_per_usd,
        "floor",
      )
      const deficitBigint = (estimatedCostCU as bigint) - (balanceCU as bigint)
      const deficit = deficitBigint > 0n ? deficitBigint : 0n

      throw new InsufficientCreditsError(
        serializeCreditUnit(balanceCU),
        serializeCreditUnit(estimatedCostCU),
        deficit.toString(),
      )
    }

    return { estimatedCostMicro, estimatedCostCU, rateSnapshot }
  }

  /**
   * Commit credits after inference completes.
   *
   * Flow: pricing.computeActualCost → CU floor → Lua atomicCommit (MicroUSD)
   * Uses frozen rate from RESERVE for consistency.
   */
  async commitCredits(
    accountId: string,
    billingEntryId: string,
    model: string,
    inputTokens: number,
    actualOutputTokens: number,
    rateSnapshot: ExchangeRateSnapshot,
    estimatedCostMicro: MicroUSD,
  ): Promise<CommitCreditResult> {
    // 1. Compute actual cost in MicroUSD (floor — user never overpays)
    const actualCostMicro = computeActualCost(model, inputTokens, actualOutputTokens)

    // 2. Convert to CU for display (floor — uses FROZEN rate from RESERVE)
    const actualCostCU = convertMicroUSDtoCreditUnit(
      actualCostMicro,
      rateSnapshot.credit_units_per_usd,
      "floor",
    )

    // 3. Atomic commit in MicroUSD via Lua
    await atomicCommit(
      this.redis,
      accountId,
      billingEntryId,
      serializeMicroUSD(actualCostMicro),
    )

    // 4. Calculate overage
    const overageMicro = (estimatedCostMicro as bigint) - (actualCostMicro as bigint)
    const overageCU = overageMicro > 0n
      ? convertMicroUSDtoCreditUnit(
          overageMicro as MicroUSD,
          rateSnapshot.credit_units_per_usd,
          "floor",
        )
      : (0n as CreditUnit)

    return { actualCostMicro, actualCostCU, overageMicro, overageCU }
  }

  /**
   * Release a reserve (pre-stream failure, user cancel, TTL expiry).
   */
  async releaseCredits(
    accountId: string,
    billingEntryId: string,
  ): Promise<boolean> {
    return atomicRelease(this.redis, accountId, billingEntryId)
  }

  /**
   * Get current balance in CreditUnit (floor — conservative display).
   */
  async getBalanceCU(
    accountId: string,
    rateSnapshot: ExchangeRateSnapshot,
  ): Promise<CreditUnit> {
    const balanceStr = await this.redis.get(`balance:${accountId}:value`) ?? "0"
    const balanceMicro = BigInt(balanceStr) as MicroUSD
    return convertMicroUSDtoCreditUnit(
      balanceMicro,
      rateSnapshot.credit_units_per_usd,
      "floor",
    )
  }
}
