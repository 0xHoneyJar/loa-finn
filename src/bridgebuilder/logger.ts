// src/bridgebuilder/logger.ts
// SanitizedLogger: wraps upstream ILogger and passes all output through
// PatternSanitizer before delegating. Defense-in-depth for log output.

import type { ILogger, IOutputSanitizer } from "./upstream.js"

export class SanitizedLogger implements ILogger {
  constructor(
    private readonly inner: ILogger,
    private readonly sanitizer: IOutputSanitizer,
  ) {}

  info(message: string, data?: Record<string, unknown>): void {
    this.inner.info(this.clean(message), this.cleanData(data))
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.inner.warn(this.clean(message), this.cleanData(data))
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.inner.error(this.clean(message), this.cleanData(data))
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.inner.debug(this.clean(message), this.cleanData(data))
  }

  private clean(message: string): string {
    return this.sanitizer.sanitize(message).sanitizedContent
  }

  /** Sanitize string values in structured data to prevent secret leakage via metadata. */
  private cleanData(data?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!data) return undefined
    const cleaned: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(data)) {
      cleaned[key] = typeof value === "string" ? this.clean(value) : value
    }
    return cleaned
  }
}
