---
status: brief
created: 2026-06-14
cycle: cycle-053
hivemind:
  schema_version: "1.0"
  artifact_type: technical-rfc
  product_area: "loa-finn — the Agent R&D Lab: wiring the Grok SIGINT sensor (WEBB's autonomous firehose)"
  workstream: experimentation
  priority: high
  jtbd: {category: functional, description: "make the Grok SIGINT sensor live so WEBB's candidate-nomination is autonomous, not a manual paste — fill-in-the-blank against the already-built seam"}
  learning_status: directionally-correct
  source: team-internal
scope_note: "The grok SENSOR SEAM is built and tested (src/research/sensors/grok.ts, boundary-enforced). What's missing is the Cheval-side xai PROVIDER it routes through. This doc is the contract for that fill-in, grounded line-by-line in the read source. It does NOT itself wire anything (no src/ edit) — it specifies the V2 build."
---

# SIGINT-WIRING — making the Grok sensor live

> The operator's standing directional: *social media with the Grok API is important
> to stay tapped in* (the GECKO instinct). This is the wiring spec. WEBB's desk
> (`roster/webb.md`) is manual today because this wire doesn't exist. Everything on
> the **lab side** is built; the missing piece is a **Cheval xai provider** on the
> framework side. This doc makes that piece fill-in-the-blank.

## What is already built (EVIDENCE — read in `src/research/sensors/grok.ts`)

The sensor is a **thin shim** that contains zero provider logic (Contract G; the
boundary scanner in `sensors/index.ts` enforces it statically — no `fetch`, no
`api.x.ai`). It reaches a model ONLY through an injected route:

```ts
// the ONLY path grok reaches a model (grok.ts)
export type ChevalXaiRoute = (input: {
  question: string
  freshness_max_age?: number
  signal?: AbortSignal
}) => Promise<ChevalXaiResult>

export interface ChevalXaiResult {
  content: string                  // the model's answer → becomes the finding
  citations?: Citation[]           // real-time refs; the probe's grounding gate judges them
  provider_resolved?: string       // Contract B honesty; defaults to "xai"
  modelinv_ref?: ModelinvRef | null// if MODELINV metered the LLM spend, reference it (no double-charge)
  inference_micro?: bigint         // research-ledger inference cost IFF modelinv_ref is null
}

export interface GrokSensorDeps {
  getApiKey?: () => string | undefined   // default: process.env.XAI_API_KEY
  chevalRoute?: ChevalXaiRoute           // UNSET ⇒ seam scaffolded ⇒ typed-unavailable
}
```

`grokAvailability(deps)` is a pure, zero-call predicate that gates in order:
1. no `XAI_API_KEY` → typed-unavailable (`SensorUnavailableError`, cost 0)
2. key present but **no `chevalRoute`** → typed-unavailable (the seam is scaffolded;
   finn's cheval has anthropic/google/openai, no xai)
3. key **and** a wired route → live; `makeGrokSensor(deps)` returns a `SensorFn`
   that calls the route and maps `ChevalXaiResult` → `SensorOutput`
   (`provider_intended: "xai"`).

So the probe can already route `sensor: "grok"` end-to-end **the moment a
`chevalRoute` is injected** — the meter, grounding gate, spine, and Contract-B
honesty all work unchanged (they're sensor-agnostic). The runner
(`grimoires/loa/lab/run-probe.ts`) passes `--sensor grok` straight through.

## What is missing (the ONE fill-in)

A **Cheval xai provider** — an adapter on the framework side that takes
`{question, freshness_max_age, signal}` and returns `ChevalXaiResult`. Two honest
build options, cheapest first:

### Option A — direct xAI Live Search adapter (thinnest path)
A small Cheval provider that calls the xAI chat-completions API with **Live Search
enabled** (the X-firehose grounding — this is the whole point of grok over gemini:
real-time X/news nowcasting). Maps the response to `ChevalXaiResult`:
- `content` ← the message content.
- `citations` ← Live Search's returned source URLs, each as a `Citation`
  (`source_type: "sigint-grok"`, `retrieved_ts: now`, `http_status` via a HEAD
  probe like the gemini sensor's `defaultLinkCheck`, `confidence: "medium"`).
- `provider_resolved` ← `"xai"` (or the actual served model family if it falls back).
- cost: if the call is metered through MODELINV, set `modelinv_ref` and leave
  `inference_micro: 0n`; otherwise compute `inference_micro` from xAI token pricing.

This adapter is **provider code and therefore belongs in Cheval / the framework
side, NOT in `src/research/sensors/`** (the boundary scanner would reject a `fetch`
or `api.x.ai` in the shim — by design). The lab injects it as `deps.grok.chevalRoute`.

### Option B — route through the existing Cheval invoker (governed path)
If/when finn's Cheval gains an `xai` provider in its model-config (the
`loa-hounfour` tier SoT), the route is a thin call into the existing Cheval invoker
with `provider: "xai"`, and MODELINV meters it automatically → `modelinv_ref` set,
`inference_micro: 0n`. Preferred long-term (single metering path, no bespoke cost
math), heavier to stand up (touches framework model-routing = System Zone).

## Acceptance (how we'll know it's live, not theater)

The same discipline the rest of the lab runs on:
1. `grokAvailability({ getApiKey, chevalRoute })` returns `{available: true}` only
   with BOTH a key and a route — verify the typed-unavailable path still fires
   without either (no silent stub).
2. A `--sensor grok` probe through `run-probe.ts` lands a `claimed` (or honest
   `insufficient`) event on the spine with `provider_intended === provider_resolved
   === "xai"` — a mismatch is a `routing_fallback`, surfaced, never counted as
   "grok works" (Contract B; the 0/758-Bedrock trap).
3. Citations from Live Search pass (or fail) the grounding gate on their own merits —
   no special-casing SIGINT to skip linkrot/freshness.
4. Cost appears EXACTLY ONCE (research ledger via `inference_micro`, or MODELINV via
   `modelinv_ref` — never both; `reconcileSpend()` dedups).

## Why it's worth building (the WEBB payoff)

Today WEBB's firehose is an operator pasting a screenshot (SETTLE-003's Kintara
candidate arrived that way). With grok live, the nomination step becomes a standing
query — *"what's crossing tribes on X right now in on-chain games / agent commerce /
Solana that the realness filter hasn't weighed?"* — run on a cadence, each hit
becoming a candidate question for PROBE→SETTLE. That is the difference between a lab
that reacts to what the operator happened to see and a lab that **scans**. It is the
GECKO "stay tapped in" instinct, mechanized and metered.

> Scope honesty: this doc specifies; it does not wire. The src/ edit (Cheval xai
> provider) is a framework-side build that goes through the normal gates. Until then,
> grok stays a typed-unavailable scaffold and WEBB stays manual — declared, not faked.
