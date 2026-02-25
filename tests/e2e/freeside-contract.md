# Freeside v7.11.0 E2E Contract

This document describes the observable surface of `loa-freeside:v7.11.0` as used by finn E2E tests.

## Image

```
ghcr.io/0xhoneyjar/loa-freeside:v7.11.0
```

## Health Endpoint

```
GET /v1/health → 200 OK
```

## Billing Endpoint (consumed by finn)

Finn's `BillingFinalizeClient` sends finalize requests to:

```
POST {ARRAKIS_BILLING_URL}/api/internal/finalize
Authorization: Bearer <S2S-JWT>
Content-Type: application/json

{
  "reservationId": "<uuid>",
  "accountId": "<tenant_id>",
  "actualCostMicro": "<string-bigint>",
  "traceId": "<uuid>"
}
```

Response on success: `200 OK` or `204 No Content`
Response on idempotent replay: `200 OK` with `{ status: "idempotent" }`

## Observable State for E2E Assertions

### Option A: Freeside HTTP API (preferred if available)

```
GET /v1/ledger/{tenant_id} → 200 OK
```

If this endpoint exists, use it to verify billing entries.

### Option B: Redis SCAN (fallback)

Freeside writes billing records to Redis. Pattern to discover:

```
SCAN 0 MATCH freeside:lot:{tenant_id}:* COUNT 100
```

Expected fields in lot entry JSON:
- `tenant_id`: string
- `direction`: "debit" | "credit"
- `amount_micro`: string (bigint)
- `trace_id`: string (correlates with finn's trace_id)
- `reservation_id`: string

### Option C: DLQ absence (minimal assertion)

If freeside is unreachable or schema differs, the minimal assertion is:
- finn's `/health` endpoint shows `billing.dlq_size === 0` (no DLQ entries)
- This proves the finalize call succeeded without needing to inspect freeside state

## Environment Variables

| Variable | Value | Purpose |
|----------|-------|---------|
| `NODE_ENV` | `test` | Runtime mode |
| `REDIS_URL` | `redis://redis-e2e:6379` | Redis connection |
| `PORT` | `3000` | Internal listen port |

## Discovery Notes

This contract should be verified at implementation time by:
1. Starting freeside with test Redis
2. Sending a test finalize request
3. Inspecting Redis keys and/or API responses
4. Updating this document with actual schema

If the actual schema differs from above, update the E2E test assertions accordingly.
