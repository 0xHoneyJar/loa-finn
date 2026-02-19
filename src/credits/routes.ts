// src/credits/routes.ts — Credit API Endpoints (Sprint 22 Task 22.2)
//
// GET /api/v1/credits/balance — current state breakdown
// GET /api/v1/credits/history — transaction log (paginated)
// POST /api/v1/credits/unlock — USDC unlock flow

import { Hono } from "hono"
import type { CreditStore, CreditAccount } from "./consumption.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreditTransaction {
  id: string
  wallet: string
  type: "allocation" | "unlock" | "reserve" | "consume" | "rollback" | "expire"
  amount: number
  timestamp: number
  metadata?: Record<string, unknown>
}

export interface CreditTransactionStore {
  getTransactions(wallet: string, limit: number, offset: number): Promise<CreditTransaction[]>
  getTransactionCount(wallet: string): Promise<number>
}

export interface UnlockHandler {
  unlock(wallet: string, authorization: Record<string, unknown>): Promise<{ success: boolean; error?: string }>
}

export interface CreditRouteDeps {
  creditStore: CreditStore
  transactionStore: CreditTransactionStore
  unlockHandler: UnlockHandler
}

// ---------------------------------------------------------------------------
// Route Factory
// ---------------------------------------------------------------------------

export function creditRoutes(deps: CreditRouteDeps): Hono {
  const app = new Hono()

  // GET /balance — current credit state breakdown
  app.get("/balance", async (c) => {
    const wallet = c.req.header("x-wallet-address")
    if (!wallet) {
      return c.json({ error: "Missing x-wallet-address header" }, 401)
    }

    const account = await deps.creditStore.getAccount(wallet)
    if (!account) {
      return c.json({
        wallet,
        allocated: 0,
        unlocked: 0,
        reserved: 0,
        consumed: 0,
        expired: 0,
        total: 0,
      })
    }

    const total = account.allocated + account.unlocked + account.reserved + account.consumed + account.expired
    return c.json({
      wallet: account.wallet,
      allocated: account.allocated,
      unlocked: account.unlocked,
      reserved: account.reserved,
      consumed: account.consumed,
      expired: account.expired,
      total,
    })
  })

  // GET /history — paginated transaction log
  app.get("/history", async (c) => {
    const wallet = c.req.header("x-wallet-address")
    if (!wallet) {
      return c.json({ error: "Missing x-wallet-address header" }, 401)
    }

    const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10), 100)
    const offset = parseInt(c.req.query("offset") ?? "0", 10)

    const [transactions, total] = await Promise.all([
      deps.transactionStore.getTransactions(wallet, limit, offset),
      deps.transactionStore.getTransactionCount(wallet),
    ])

    return c.json({
      wallet,
      transactions,
      pagination: {
        limit,
        offset,
        total,
        hasMore: offset + limit < total,
      },
    })
  })

  // POST /unlock — USDC unlock flow
  app.post("/unlock", async (c) => {
    const wallet = c.req.header("x-wallet-address")
    if (!wallet) {
      return c.json({ error: "Missing x-wallet-address header" }, 401)
    }

    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400)
    }

    const result = await deps.unlockHandler.unlock(wallet, body)
    if (!result.success) {
      return c.json({ error: result.error ?? "Unlock failed" }, 400)
    }

    return c.json({ success: true, wallet })
  })

  return app
}
