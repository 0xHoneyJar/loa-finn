// src/agent/audit-log.ts — Append-only audit log for sandbox decisions (SDD §3.6)

import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync, readdirSync } from "node:fs"
import { join } from "node:path"

export interface AuditEntry {
  timestamp: string
  action: "allow" | "deny"
  command: string
  args: string[]
  reason?: string
  duration?: number
  outputSize?: number
}

export class AuditLog {
  private readonly logDir: string
  private currentFile: string
  private currentSize: number
  private readonly maxFileSize: number
  private readonly maxFiles: number

  constructor(dataDir: string, options?: { maxFileSize?: number; maxFiles?: number }) {
    this.logDir = join(dataDir, "audit")
    this.maxFileSize = options?.maxFileSize ?? 10 * 1024 * 1024 // 10MB
    this.maxFiles = options?.maxFiles ?? 5
    this.currentFile = join(this.logDir, "audit.log")
    this.currentSize = 0

    try {
      mkdirSync(this.logDir, { recursive: true })
    } catch {
      // Directory creation failed — append will fail too
    }

    try {
      this.currentSize = statSync(this.currentFile).size
    } catch {
      // File doesn't exist yet, size stays 0
    }
  }

  append(entry: AuditEntry): boolean {
    try {
      this.maybeRotate()
      const line = JSON.stringify(entry) + "\n"
      appendFileSync(this.currentFile, line)
      this.currentSize += Buffer.byteLength(line)
      return true
    } catch {
      return false
    }
  }

  private maybeRotate(): void {
    if (this.currentSize < this.maxFileSize) return

    // Shift existing rotated files: audit.4.log → delete, audit.3.log → audit.4.log, etc.
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const src = join(this.logDir, `audit.${i}.log`)
      const dst = join(this.logDir, `audit.${i + 1}.log`)
      try {
        if (i + 1 >= this.maxFiles) {
          unlinkSync(dst)
        }
      } catch { /* file may not exist */ }
      try {
        renameSync(src, dst)
      } catch { /* file may not exist */ }
    }

    // Current → audit.1.log
    try {
      renameSync(this.currentFile, join(this.logDir, "audit.1.log"))
    } catch { /* best effort */ }

    this.currentSize = 0
  }

  getLogDir(): string {
    return this.logDir
  }
}
