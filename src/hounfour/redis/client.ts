// src/hounfour/redis/client.ts — Redis state backend (SDD §4.6.1, T-2.7)
//
// Singleton Redis client for Hounfour components. Uses a port interface
// so the actual Redis library (ioredis) is injected at boot time.

// --- Types ---

export type RedisConnectionState = "connecting" | "connected" | "disconnected"

export interface RedisConfig {
  url: string                    // redis://localhost:6379
  keyPrefix: string              // Default: "finn:hounfour"
  connectTimeoutMs: number       // Default: 5000
  commandTimeoutMs: number       // Default: 3000
  maxRetriesPerRequest: number   // Default: 1 (fail fast)
  enableOfflineQueue: boolean    // Default: false (reject when disconnected)
}

export const DEFAULT_REDIS_CONFIG: Omit<RedisConfig, "url"> = {
  keyPrefix: "finn:hounfour",
  connectTimeoutMs: 5000,
  commandTimeoutMs: 3000,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
}

/** Minimal Redis command interface (subset of ioredis API) */
export interface RedisCommandClient {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>
  del(...keys: string[]): Promise<number>
  incrby(key: string, increment: number): Promise<number>
  incrbyfloat(key: string, increment: number): Promise<string>
  expire(key: string, seconds: number): Promise<number>
  exists(...keys: string[]): Promise<number>
  ping(): Promise<string>
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>
  hgetall(key: string): Promise<Record<string, string>>
  hincrby(key: string, field: string, increment: number): Promise<number>
  zadd(key: string, score: number, member: string): Promise<number>
  zpopmin(key: string, count?: number): Promise<string[]>
  zremrangebyscore(key: string, min: string | number, max: string | number): Promise<number>
  zcard(key: string): Promise<number>
  publish(channel: string, message: string): Promise<number>
  quit(): Promise<string>
}

/** Minimal Redis subscriber interface (separate connection) */
export interface RedisSubscriberClient {
  subscribe(channel: string): Promise<number>
  unsubscribe(channel: string): Promise<number>
  on(event: string, handler: (...args: any[]) => void): void
  quit(): Promise<string>
}

/** Factory to create Redis command + subscriber clients */
export interface RedisClientFactory {
  createCommandClient(config: RedisConfig): RedisCommandClient & { on(event: string, handler: (...args: any[]) => void): void }
  createSubscriberClient(config: RedisConfig): RedisSubscriberClient
}

// --- RedisStateBackend ---

/**
 * Singleton Redis state backend for Hounfour components.
 *
 * Two connections (not a pool — ioredis uses one TCP connection per instance):
 *   1. `client` — command connection for GET/SET/INCRBYFLOAT/Lua scripts
 *   2. `subscriber` — dedicated Pub/Sub connection (ioredis requirement)
 *
 * Connection State (tri-state):
 *   - CONNECTING: initial connection attempt in progress
 *   - CONNECTED: Redis is reachable, commands succeed
 *   - DISCONNECTED: Redis is unreachable, commands will fail
 *
 * Failure Mode:
 *   Redis unavailability is NOT fatal for circuit/rate components (fail-open).
 *   Budget component requires Redis (fail-closed) — see redis/budget.ts.
 */
export class RedisStateBackend {
  private client: (RedisCommandClient & { on(event: string, handler: (...args: any[]) => void): void }) | null = null
  private subscriber: RedisSubscriberClient | null = null
  private _state: RedisConnectionState = "connecting"
  private waiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = []

  constructor(
    private config: RedisConfig,
    private factory: RedisClientFactory,
  ) {}

  /**
   * Connect to Redis and await initial connection (bounded).
   *
   * Waits up to connectTimeoutMs for the first successful connection.
   * If connection fails within timeout: state = "disconnected", logged as warning.
   */
  async connect(): Promise<void> {
    this._state = "connecting"

    this.client = this.factory.createCommandClient(this.config)
    this.subscriber = this.factory.createSubscriberClient(this.config)

    // Register event handlers
    this.client.on("connect", () => {
      this._state = "connected"
      // Resolve all waiters
      for (const waiter of this.waiters) waiter.resolve()
      this.waiters = []
    })

    this.client.on("error", () => {
      if (this._state === "connected") {
        this._state = "disconnected"
      }
    })

    this.client.on("close", () => {
      this._state = "disconnected"
    })

    this.client.on("reconnecting", () => {
      this._state = "connecting"
    })

    // Wait for initial connection with timeout
    try {
      await this.waitUntilReady(this.config.connectTimeoutMs)
    } catch {
      this._state = "disconnected"
      console.warn("[redis] Initial connection failed, state = DISCONNECTED")
    }
  }

  /**
   * Wait for Redis to be in CONNECTED state, with timeout.
   * Used by budget enforcer at startup to ensure fail-closed semantics.
   */
  async waitUntilReady(timeoutMs: number): Promise<void> {
    if (this._state === "connected") return

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove from waiters
        const idx = this.waiters.findIndex(w => w.resolve === resolve)
        if (idx >= 0) this.waiters.splice(idx, 1)
        reject(new Error(`Redis not ready within ${timeoutMs}ms`))
      }, timeoutMs)

      this.waiters.push({
        resolve: () => { clearTimeout(timer); resolve() },
        reject: (err) => { clearTimeout(timer); reject(err) },
      })

      // If already connected by the time we register, resolve immediately
      if (this._state === "connected") {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  /** Key helper — applies prefix + component namespace */
  key(component: string, ...parts: string[]): string {
    return `${this.config.keyPrefix}:${component}:${parts.join(":")}`
  }

  /** Raw command client access (for Lua scripts, pipelines) */
  getClient(): RedisCommandClient {
    if (!this.client) throw new Error("Redis not connected — call connect() first")
    return this.client
  }

  /** Pub/Sub subscriber */
  getSubscriber(): RedisSubscriberClient {
    if (!this.subscriber) throw new Error("Redis not connected — call connect() first")
    return this.subscriber
  }

  /** Connection state for health reporting */
  get state(): RedisConnectionState {
    return this._state
  }

  /** Whether the command client is connected */
  isConnected(): boolean {
    return this._state === "connected"
  }

  /** Health ping with timeout */
  async ping(): Promise<{ connected: boolean; latencyMs: number }> {
    if (!this.client || this._state !== "connected") {
      return { connected: false, latencyMs: 0 }
    }
    const start = Date.now()
    try {
      await this.client.ping()
      return { connected: true, latencyMs: Date.now() - start }
    } catch {
      return { connected: false, latencyMs: Date.now() - start }
    }
  }

  /** Graceful disconnect */
  async disconnect(): Promise<void> {
    const promises: Promise<unknown>[] = []
    if (this.client) promises.push(this.client.quit().catch(() => {}))
    if (this.subscriber) promises.push(this.subscriber.quit().catch(() => {}))
    await Promise.all(promises)
    this._state = "disconnected"
    this.client = null
    this.subscriber = null
  }
}
