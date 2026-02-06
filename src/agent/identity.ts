// src/agent/identity.ts — BEAUVOIR.md identity loader (SDD §3.1.2)

import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"

export class IdentityLoader {
  private content: string | null = null
  private checksum: string | null = null

  constructor(private beauvoirPath: string) {}

  async load(): Promise<string> {
    try {
      this.content = await readFile(this.beauvoirPath, "utf-8")
      this.checksum = createHash("sha256").update(this.content).digest("hex")
      return this.content
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        console.warn(`[identity] BEAUVOIR.md not found at ${this.beauvoirPath}, using empty system prompt`)
        this.content = ""
        this.checksum = createHash("sha256").update("").digest("hex")
        return ""
      }
      throw err
    }
  }

  getChecksum(): string {
    if (!this.checksum) {
      throw new Error("Identity not loaded yet. Call load() first.")
    }
    return this.checksum
  }

  getContent(): string {
    return this.content ?? ""
  }
}
