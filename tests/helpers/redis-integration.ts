// tests/helpers/redis-integration.ts — Real Redis Connection Helper (Sprint 13 Task 13.3)
//
// Provides getTestRedis() for integration tests that run against Docker Redis.
// Port 6381 (tests/docker-compose.test.yml maps 6381 → 6379).
//
// Uses net.Socket directly to avoid requiring ioredis/redis as a dependency.
// For full integration tests, ioredis should be installed as a dev dependency.

import { createConnection, type Socket } from "node:net"

const REDIS_HOST = process.env.REDIS_TEST_HOST ?? "localhost"
const REDIS_PORT = parseInt(process.env.REDIS_TEST_PORT ?? "6381", 10)

/**
 * Minimal Redis client using raw TCP RESP protocol.
 * Sufficient for integration test commands (GET, SET, PING, FLUSHDB, EVAL).
 */
export class MinimalRedisClient {
  private socket: Socket | null = null
  private responseQueue: Array<{
    resolve: (value: string) => void
    reject: (error: Error) => void
  }> = []
  private buffer = ""

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = createConnection({ host: REDIS_HOST, port: REDIS_PORT }, () => {
        resolve()
      })
      this.socket.setEncoding("utf-8")
      this.socket.on("data", (data: string) => {
        this.buffer += data
        this.processBuffer()
      })
      this.socket.on("error", (err) => {
        reject(err)
        // Reject any pending responses
        for (const pending of this.responseQueue) {
          pending.reject(err)
        }
        this.responseQueue = []
      })
    })
  }

  async command(...args: string[]): Promise<string> {
    if (!this.socket) throw new Error("Not connected")

    return new Promise((resolve, reject) => {
      this.responseQueue.push({ resolve, reject })
      // RESP array format: *N\r\n$len\r\narg\r\n...
      const parts = [`*${args.length}\r\n`]
      for (const arg of args) {
        parts.push(`$${Buffer.byteLength(arg)}\r\n${arg}\r\n`)
      }
      this.socket!.write(parts.join(""))
    })
  }

  async get(key: string): Promise<string | null> {
    const result = await this.command("GET", key)
    return result === "$-1" ? null : result
  }

  async set(key: string, value: string): Promise<string> {
    return this.command("SET", key, value)
  }

  async ping(): Promise<string> {
    return this.command("PING")
  }

  async flushDb(): Promise<string> {
    return this.command("FLUSHDB")
  }

  async quit(): Promise<void> {
    if (this.socket) {
      try {
        await this.command("QUIT")
      } catch { /* ignore */ }
      this.socket.destroy()
      this.socket = null
    }
  }

  get isOpen(): boolean {
    return this.socket !== null && !this.socket.destroyed
  }

  private processBuffer(): void {
    // Simple RESP parser for single-line and bulk string responses
    while (this.buffer.length > 0 && this.responseQueue.length > 0) {
      const firstChar = this.buffer[0]
      const newlineIdx = this.buffer.indexOf("\r\n")
      if (newlineIdx === -1) return // Incomplete response

      if (firstChar === "+" || firstChar === "-" || firstChar === ":") {
        // Simple string, error, or integer
        const line = this.buffer.slice(1, newlineIdx)
        this.buffer = this.buffer.slice(newlineIdx + 2)
        const pending = this.responseQueue.shift()!
        if (firstChar === "-") {
          pending.reject(new Error(line))
        } else {
          pending.resolve(line)
        }
      } else if (firstChar === "$") {
        // Bulk string
        const length = parseInt(this.buffer.slice(1, newlineIdx), 10)
        if (length === -1) {
          this.buffer = this.buffer.slice(newlineIdx + 2)
          this.responseQueue.shift()!.resolve("$-1")
        } else {
          const dataStart = newlineIdx + 2
          const dataEnd = dataStart + length + 2 // +2 for trailing \r\n
          if (this.buffer.length < dataEnd) return // Incomplete
          const data = this.buffer.slice(dataStart, dataStart + length)
          this.buffer = this.buffer.slice(dataEnd)
          this.responseQueue.shift()!.resolve(data)
        }
      } else if (firstChar === "*") {
        // Array — for simplicity, resolve as raw string
        const line = this.buffer.slice(0, newlineIdx)
        this.buffer = this.buffer.slice(newlineIdx + 2)
        this.responseQueue.shift()!.resolve(line)
      } else {
        // Unknown — consume line
        this.buffer = this.buffer.slice(newlineIdx + 2)
        this.responseQueue.shift()!.resolve("")
      }
    }
  }
}

let client: MinimalRedisClient | null = null

/**
 * Get a connected Redis client for integration tests.
 * Reuses the same connection across tests in a suite.
 */
export async function getTestRedis(): Promise<MinimalRedisClient> {
  if (client && client.isOpen) return client

  client = new MinimalRedisClient()
  await client.connect()
  return client
}

/**
 * Flush the test Redis database (use between tests for isolation).
 */
export async function flushTestRedis(): Promise<void> {
  const redis = await getTestRedis()
  await redis.flushDb()
}

/**
 * Disconnect the test Redis client (use in afterAll).
 */
export async function disconnectTestRedis(): Promise<void> {
  if (client && client.isOpen) {
    await client.quit()
    client = null
  }
}

/**
 * Check if Docker Redis is available (for skip logic).
 */
export async function isRedisAvailable(): Promise<boolean> {
  try {
    const redis = await getTestRedis()
    const pong = await redis.ping()
    return pong === "PONG"
  } catch {
    return false
  }
}
