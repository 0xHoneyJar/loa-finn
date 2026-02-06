// src/agent/identity.ts — BEAUVOIR.md identity loader (SDD §3.1.2)

import { readFile } from "node:fs/promises"
import { watch, type FSWatcher } from "node:fs"
import { createHash } from "node:crypto"

export class IdentityLoader {
  private content: string | null = null
  private checksum: string | null = null
  private watcher: FSWatcher | undefined
  private debounceTimer: ReturnType<typeof setTimeout> | undefined

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

  /** Watch BEAUVOIR.md for changes with 1s debounce (T-4.5). */
  watch(onChange: (content: string) => void): void {
    if (this.watcher) return
    try {
      this.watcher = watch(this.beauvoirPath, () => {
        if (this.debounceTimer) clearTimeout(this.debounceTimer)
        this.debounceTimer = setTimeout(async () => {
          await this.checkAndReload(onChange)
        }, 1000)
      })
      this.watcher.unref()
    } catch {
      // File may not exist yet
    }
  }

  /** Check for changes and reload if checksum differs. */
  async checkAndReload(onChange?: (content: string) => void): Promise<boolean> {
    try {
      const newContent = await readFile(this.beauvoirPath, "utf-8")
      const newChecksum = createHash("sha256").update(newContent).digest("hex")
      if (newChecksum !== this.checksum) {
        this.content = newContent
        this.checksum = newChecksum
        console.log("[identity] BEAUVOIR.md changed, identity reloaded")
        onChange?.(newContent)
        return true
      }
    } catch {
      // Ignore — file might be mid-write
    }
    return false
  }

  stopWatching(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    if (this.watcher) {
      this.watcher.close()
      this.watcher = undefined
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
