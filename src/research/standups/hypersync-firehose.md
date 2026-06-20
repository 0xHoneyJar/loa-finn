# Stand-up runbook — HyperSync firehose → Postgres + ClickHouse (L2 POC)

> Purpose: upgrade the 8 L2 rows from **projected** (storage extrapolated from
> published rates × Dune-measured event counts) to **measured** — real bytes on
> disk + real query latency for the wildcard `Transfer` firehose on ONE chain.
>
> THIS IS A POC ONLY. Do NOT build the multi-chain "millions of collections"
> product — the verdict showed it doesn't exist on one chain (~406k collections /
> ~40GB columnar on Ethereum). Build this only to confirm the storage delta and
> the query-latency curve if/when Layer-2 is actually pursued.

## What to measure (the load-bearing deltas)

1. **Storage on real data** — index ALL ERC-721/ERC-1155 `Transfer` logs by event
   signature (no per-contract registration) into Postgres AND ClickHouse, same
   data, two stores. Measure **actual bytes on disk** at each scale point. The
   projection assumed ~100 B/row (CH) / ~600 B/row (PG); confirm or correct it.
2. **Query latency** — p50 for "what does wallet 0x… hold across all collections"
   at each scale. The projected rows have `latency_p50_ms: null` precisely because
   nobody has measured it. Fill it in.
3. **The compression ratio** — CH compressed size ÷ PG size, on the SAME Transfer
   set (the projection used ~6×, anchored to CryptoHouse's 6.11× on real on-chain
   token transfers; measure the real ratio for this exact data shape).

## Steps

1. **Extract** — HyperSync wildcard `Transfer(address,address,uint256)` +
   ERC-1155 `TransferSingle`/`TransferBatch` by topic0, one chain (Ethereum = the
   worst case). HyperSync dev access is free/rate-limited (token since 2025-11);
   production rate is unpublished → record what you actually pay.
   (https://docs.envio.dev/docs/HyperSync — exact client per docs.)
2. **Land in BOTH stores** — same decoded rows → Postgres (Railway, RAM is the
   cost lever at $10/GB-mo) AND ClickHouse Cloud ($25.30/TB-mo storage,
   $0.22–0.30/unit-hr compute, no free tier — 30d $300 trial).
3. **Measure at scale points** {100, 10k, 100k, all}. For each store × scale:
   real `bytes_on_disk`, derived `$/mo`, and p50 query latency. Use the SAME
   Dune-anchored event counts (69M / 264M / 391M / 396M) to validate row counts.
4. **Log toil** for each (the firehose has its own ops: schema migrations,
   re-orgs, ClickHouse part-merge tuning, Postgres VACUUM/index bloat).

## Capture each measured row

```bash
# one per (store × scale) — example: ClickHouse @ all
pnpm indexing:capture add --row '{
  "row_id":"idx-tco-exp-2026-06-16::hypersync->clickhouse::scale-all-measured",
  "run_id":"idx-tco-exp-2026-06-16","date":"<date>","scenario":"scale-all",
  "layer":"L2-firehose","config":"hypersync->clickhouse","chain":1,
  "collection_count":405846,"event_count":396293970,
  "cost_usd_month":<REAL_STORAGE_PLUS_COMPUTE>,"cost_source":"measured",
  "toil_minutes_setup":<TIMED>,"toil_incidents_30d":<COUNTED>,"toil_minutes_per_incident":<AVG>,
  "latency_p50_ms":<MEASURED>,"freshness_lag_s":<MEASURED>,"sovereignty":0,
  "scale_ceiling":"<observed bytes/row + the real CH:PG ratio>",
  "cost_basis":"measured bytes on disk × ClickHouse Cloud rates <date>, incl compute",
  "retrieved_ts":null,"notes":"measured upgrade of the scale-all CH projection"
}'
pnpm indexing:read   # storage_delta_usd_at_max now reflects MEASURED bytes
```

## Teardown

Tear down both stacks after measuring. Their cost is the POC's cost, not a new
always-on line item. The firehose stays a *future* concern until a multi-chain
requirement is actually documented.
