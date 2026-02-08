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
    this.inner.info(this.clean(message), data)
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.inner.warn(this.clean(message), data)
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.inner.error(this.clean(message), data)
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.inner.debug(this.clean(message), data)
  }

  private clean(message: string): string {
    return this.sanitizer.sanitize(message).sanitizedContent
  }
}
