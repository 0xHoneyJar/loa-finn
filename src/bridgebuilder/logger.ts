// src/bridgebuilder/logger.ts
import type { IOutputSanitizer } from "./ports/index.js"

export class BridgebuilderLogger {
  constructor(private readonly sanitizer: IOutputSanitizer) {}

  info(msg: string): void {
    const { sanitizedContent } = this.sanitizer.sanitize(msg)
    console.log(`[bridgebuilder] ${sanitizedContent}`)
  }

  warn(msg: string): void {
    const { sanitizedContent } = this.sanitizer.sanitize(msg)
    console.warn(`[bridgebuilder] ${sanitizedContent}`)
  }

  error(msg: string, err?: unknown): void {
    const { sanitizedContent } = this.sanitizer.sanitize(msg)
    if (err instanceof Error) {
      const { sanitizedContent: errMsg } = this.sanitizer.sanitize(err.message)
      console.error(`[bridgebuilder] ${sanitizedContent}: ${errMsg}`)
    } else {
      console.error(`[bridgebuilder] ${sanitizedContent}`)
    }
  }

  debug(msg: string): void {
    if (process.env.BRIDGEBUILDER_DEBUG === "true") {
      const { sanitizedContent } = this.sanitizer.sanitize(msg)
      console.log(`[bridgebuilder:debug] ${sanitizedContent}`)
    }
  }
}
