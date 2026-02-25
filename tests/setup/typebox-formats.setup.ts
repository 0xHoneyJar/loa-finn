// tests/setup/typebox-formats.setup.ts — Vitest setup file for TypeBox format registration
//
// Ensures uuid and date-time formats are registered in FormatRegistry before any test runs.
// Add to vitest setupFiles to guarantee deterministic format registration regardless of
// test order or module isolation.

import "../../src/hounfour/typebox-formats.js"
