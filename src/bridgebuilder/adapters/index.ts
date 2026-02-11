// src/bridgebuilder/adapters/index.ts
// Adapter factory: wraps upstream createLocalAdapters() with finn R2ContextStore override.

import {
  createLocalAdapters,
  NoOpContextStore,
  type IContextStore,
  type BridgebuilderConfig,
} from "../upstream.js"
import type { LocalAdapters } from "../upstream.js"
import { R2ContextStore } from "./r2-context.js"
import { R2Client, type R2ClientConfig } from "../r2-client.js"

export interface FinnAdapters extends LocalAdapters {
  contextStore: IContextStore
}

/**
 * Create finn adapters by calling upstream createLocalAdapters() and optionally
 * overriding the context store with R2ContextStore when R2 is configured.
 */
export function createFinnAdapters(
  config: BridgebuilderConfig,
  anthropicApiKey: string,
  r2Config: R2ClientConfig | null,
): FinnAdapters {
  const upstream = createLocalAdapters(config, anthropicApiKey)

  if (r2Config) {
    const r2Client = new R2Client(r2Config)
    const contextStore = new R2ContextStore(r2Client)
    return { ...upstream, contextStore }
  }

  // Explicitly ensure NoOpContextStore when R2 not configured
  const contextStore = upstream.contextStore ?? new NoOpContextStore()
  return { ...upstream, contextStore }
}
