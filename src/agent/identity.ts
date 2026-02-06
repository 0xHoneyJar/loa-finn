// src/agent/identity.ts — Re-export upstream IdentityLoader (T-7.6)
// Finn uses upstream IdentityLoader for BEAUVOIR.md parsing + hot-reload.

export {
  IdentityLoader,
  createIdentityLoader,
} from "../persistence/upstream.js"

export type {
  IdentityLoaderConfig,
  IdentityDocument,
  Principle,
  Boundary,
} from "../persistence/upstream.js"
