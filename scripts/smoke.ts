#!/usr/bin/env tsx
// scripts/smoke.ts — Smoke test: boot agent, send one message, verify response (T-1.7)

import { loadConfig } from "../src/config.js"
import { createLoaSession } from "../src/agent/session.js"

const message = process.argv[2] ?? "Hello, I am testing the loa-finn agent. Please respond with a short greeting."

async function smoke() {
  console.log(`[smoke] booting loa-finn agent...`)
  const startTime = Date.now()

  const config = loadConfig()
  console.log(`[smoke] config: model=${config.model}, thinkingLevel=${config.thinkingLevel}`)

  const { session, sessionId } = await createLoaSession({ config })
  console.log(`[smoke] session created: ${sessionId}`)

  // Subscribe to events for logging
  let responseText = ""
  session.subscribe((event) => {
    if (event.type === "message_end") {
      const msg = event.message
      if (msg.role === "assistant" && msg.content) {
        for (const block of msg.content) {
          if (block.type === "text") {
            responseText += block.text
          }
        }
      }
    }
  })

  // Send the message
  console.log(`[smoke] sending: "${message}"`)
  await session.prompt(message)

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

  if (responseText.length === 0) {
    console.error(`[smoke] FAIL — no response received (${elapsed}s)`)
    session.dispose()
    process.exit(1)
  }

  console.log(`[smoke] response (${elapsed}s):`)
  console.log(responseText)
  console.log(`[smoke] PASS — coherent response received`)

  session.dispose()
  process.exit(0)
}

smoke().catch((err) => {
  console.error("[smoke] FAIL:", err)
  process.exit(1)
})
