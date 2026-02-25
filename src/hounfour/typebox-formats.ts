// src/hounfour/typebox-formats.ts — TypeBox Format Registration
//
// Registers JSON Schema format validators (uuid, date-time) with TypeBox's
// FormatRegistry. Required before Value.Check on schemas using format constraints.
// Import this module for side effects before any Value.Check call.

import { FormatRegistry } from "@sinclair/typebox"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (value) => typeof value === "string" && UUID_RE.test(value))
}

if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (value) => typeof value === "string" && !isNaN(Date.parse(value)))
}
