# Stand-up runbook — Envio HyperIndex (upgrade the 1x quote → measured)

> Purpose: turn the `envio-hyperindex / 1x` row from **vendor-quote** ($70, the
> operator's un-reconfirmed lived figure) into **measured** — one real billing
> cycle on the identical footprint. This is the ONLY thing between the verdict's
> "direction settled" and "ratify."
>
> Measurement integrity: log toil AS IT HAPPENS (not post-hoc). Tag the final
> number `measured` only after a real invoice exists.

## Footprint to reproduce (must match the Ponder baseline exactly)

- **Chain:** Berachain Mainnet, id **80094** (Envio first-class HyperSync — verified).
- **Contracts:** the ~93 curated contracts in `sonar-api/config.yaml` (+ `ponder.config.mibera.ts`).
- **Output:** a GraphQL API serving the same entities the belt-gateway exposes.
- Same chain / same contract set / same time-window, or the comparison is noise.

## Steps

1. **Scaffold** — `pnpx envio init` → choose Contract-import, paste the 93 contract
   addresses + ABIs. Authors `config.yaml` + `schema.graphql` + `src/EventHandlers.ts`.
   (Exact flags: https://docs.envio.dev/docs/HyperIndex/getting-started — do not
   guess; follow the current docs.) **START A TOIL TIMER NOW.**
2. **Map the entities** to match what score-api/inventory-api consume (ownership,
   transfers, the Mibera/Purupuru/Sprawl/HoneyJar collections). The entity shape
   drives Goldsky-style storage cost too — keep it lean.
3. **Deploy hosted** — Envio Cloud (bundled HyperSync, no custom token) on a
   Production tier. The exact $ tier is Discord-quote-gated — **record the quoted
   $/mo + tier name** the moment you get it (that becomes `cost_basis`).
4. **Backfill + go live**, confirm freshness vs the live Ponder belt (sample N
   blocks, compare entity counts). Record `freshness_lag_s` (real, not "real-time").
5. **Run one full billing cycle (30d).** Log EVERY intervention to the toil ledger
   as it happens: `toil_incidents_30d` + minutes each. (Expectation: 0 — that's the
   thesis. If non-zero, that's a real finding.)

## Capture the measured row

After the invoice lands:

```bash
pnpm indexing:capture add --row '{
  "row_id":"idx-tco-exp-2026-06-16::envio-hyperindex::1x-measured",
  "run_id":"idx-tco-exp-2026-06-16","date":"<invoice-date>","scenario":"1x",
  "layer":"L1-curated","config":"envio-hyperindex","chain":80094,
  "collection_count":93,"event_count":3540000,
  "cost_usd_month":<REAL_INVOICE_USD>,"cost_source":"measured",
  "toil_minutes_setup":<TIMED>,"toil_incidents_30d":<COUNTED>,"toil_minutes_per_incident":<AVG>,
  "latency_p50_ms":<MEASURED>,"freshness_lag_s":<MEASURED>,"sovereignty":0,
  "scale_ceiling":"<observed>","cost_basis":"Envio Cloud invoice <date>, tier <name>, footprint = 93 Berachain contracts",
  "retrieved_ts":null,"notes":"measured upgrade of the 1x quote"
}'
pnpm indexing:read   # re-run the crossover; 1x trust should rise quote → measured
```

When BOTH the Ponder and Envio 1x rows are `measured`, `pnpm indexing:read` emits
`RATIFY: every input is measured` for the 1x footprint — that is the ratification gate.

## Teardown

This is a POC. After the billing cycle + capture, **tear down the Envio stack** — its
cost is the POC's cost, not a new always-on line item (unless the decision is to adopt).
