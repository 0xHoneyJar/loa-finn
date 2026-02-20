// src/nft/transfer-listener.ts — ERC-721 Transfer Event Listener (Sprint 14 Task 14.1)
//
// Listens for ERC-721 Transfer events on a specific contract address.
// On transfer: invalidates the owner cache entry for the transferred token.
// Handles reconnection with exponential backoff on WebSocket disconnect.
// Uses viem for contract event watching (consistent with chain-config.ts).

import { type WatchContractEventReturnType } from "viem"
import { invalidateOwnerCache } from "../gateway/siwe-ownership.js"

// ---------------------------------------------------------------------------
// ERC-721 Transfer Event ABI
// ---------------------------------------------------------------------------

const ERC721_TRANSFER_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
] as const

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal viem-compatible client interface for event watching */
export interface EventWatcherClient {
  watchContractEvent: (args: {
    address: `0x${string}`
    abi: typeof ERC721_TRANSFER_ABI
    eventName: "Transfer"
    onLogs: (logs: Array<{
      args: { from?: string; to?: string; tokenId?: bigint }
    }>) => void
    onError?: (error: Error) => void
  }) => WatchContractEventReturnType
}

export interface TransferListenerConfig {
  /** Maximum backoff delay in milliseconds (default: 30000) */
  maxBackoffMs?: number
  /** Base backoff delay in milliseconds (default: 1000) */
  baseBackoffMs?: number
  /** Maximum number of consecutive reconnect attempts before giving up (default: 10) */
  maxRetries?: number
  /** Optional callback for transfer events (in addition to cache invalidation) */
  onTransfer?: (from: string, to: string, tokenId: string) => void
  /** Optional error callback for monitoring */
  onError?: (error: Error) => void
  /** Optional callback when listener reconnects */
  onReconnect?: (attempt: number) => void
}

// ---------------------------------------------------------------------------
// TransferListener
// ---------------------------------------------------------------------------

export class TransferListener {
  private readonly client: EventWatcherClient
  private readonly contractAddress: `0x${string}`
  private readonly collection: string
  private readonly config: Required<
    Pick<TransferListenerConfig, "maxBackoffMs" | "baseBackoffMs" | "maxRetries">
  > & Pick<TransferListenerConfig, "onTransfer" | "onError" | "onReconnect">

  private unwatch: WatchContractEventReturnType | null = null
  private running = false
  private retryCount = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    client: EventWatcherClient,
    contractAddress: `0x${string}`,
    collection: string,
    config?: TransferListenerConfig,
  ) {
    this.client = client
    this.contractAddress = contractAddress
    this.collection = collection
    this.config = {
      maxBackoffMs: config?.maxBackoffMs ?? 30_000,
      baseBackoffMs: config?.baseBackoffMs ?? 1_000,
      maxRetries: config?.maxRetries ?? 10,
      onTransfer: config?.onTransfer,
      onError: config?.onError,
      onReconnect: config?.onReconnect,
    }
  }

  /**
   * Start listening for Transfer events.
   * Idempotent — calling start() when already running is a no-op.
   */
  start(): void {
    if (this.running) return
    this.running = true
    this.retryCount = 0
    this.subscribe()
  }

  /**
   * Stop listening for Transfer events.
   * Cancels any pending reconnection timers.
   * Idempotent — calling stop() when already stopped is a no-op.
   */
  stop(): void {
    this.running = false
    if (this.unwatch) {
      this.unwatch()
      this.unwatch = null
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.retryCount = 0
  }

  /** Whether the listener is currently active */
  get isRunning(): boolean {
    return this.running
  }

  /** Current retry count (for monitoring/testing) */
  get currentRetryCount(): number {
    return this.retryCount
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private subscribe(): void {
    if (!this.running) return

    try {
      this.unwatch = this.client.watchContractEvent({
        address: this.contractAddress,
        abi: ERC721_TRANSFER_ABI,
        eventName: "Transfer",
        onLogs: (logs) => {
          for (const log of logs) {
            this.handleTransferLog(log)
          }
        },
        onError: (error) => {
          this.handleError(error)
        },
      })
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private handleTransferLog(log: {
    args: { from?: string; to?: string; tokenId?: bigint }
  }): void {
    const { from, to, tokenId } = log.args

    if (tokenId === undefined) return

    const tokenIdStr = tokenId.toString()

    // Invalidate the owner cache so the next read fetches fresh on-chain data
    invalidateOwnerCache(this.collection, tokenIdStr)

    // Fire optional callback
    if (this.config.onTransfer) {
      this.config.onTransfer(
        from ?? "0x0000000000000000000000000000000000000000",
        to ?? "0x0000000000000000000000000000000000000000",
        tokenIdStr,
      )
    }
  }

  private handleError(error: Error): void {
    // Notify error callback
    if (this.config.onError) {
      this.config.onError(error)
    }

    // If we've been stopped while an error was in-flight, don't reconnect
    if (!this.running) return

    // Clean up the current watcher
    if (this.unwatch) {
      try {
        this.unwatch()
      } catch {
        // Best-effort cleanup
      }
      this.unwatch = null
    }

    // Attempt reconnection with exponential backoff
    this.retryCount++

    if (this.retryCount > this.config.maxRetries) {
      // Exceeded max retries — stop the listener
      this.running = false
      if (this.config.onError) {
        this.config.onError(
          new Error(`TransferListener: max retries (${this.config.maxRetries}) exceeded, stopping`),
        )
      }
      return
    }

    // Exponential backoff: base * 2^(retry-1), capped at maxBackoff
    const delay = Math.min(
      this.config.baseBackoffMs * Math.pow(2, this.retryCount - 1),
      this.config.maxBackoffMs,
    )

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.running) {
        if (this.config.onReconnect) {
          this.config.onReconnect(this.retryCount)
        }
        this.subscribe()
      }
    }, delay)
  }
}
