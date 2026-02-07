// src/bridgebuilder/ports/hasher.ts

/**
 * Hashing port for portability. Core never imports node:crypto directly.
 * Railway adapter uses node:crypto; arrakis/edge/browser adapters can
 * use WebCrypto, Deno crypto, or any SHA-256 implementation.
 */
export interface IHasher {
  /** Compute SHA-256 hex digest of the given input string. */
  sha256(input: string): string
}
