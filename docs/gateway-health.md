# Gateway Health Endpoints

Documented behavior of the three health surfaces in `src/gateway/server.ts`
(#207, #218). Tests: `tests/finn/gateway/health.test.ts`.

| Route | Purpose | Status codes | Body |
|-------|---------|--------------|------|
| `GET /healthz` | Liveness probe (ALB). No dependency checks. | Always `200` while the process is alive | `{ status: "ok", uptime }` |
| `GET /health/deps` | Readiness probe. Checks Redis + DynamoDB data-plane. | `200` when all configured deps healthy; `503` when any critical dep is unreachable or errors | `{ status: "ready" \| "not_ready", checks: { redis?, dynamodb? } }` |
| `GET /health` | Full diagnostic document for operators/monitoring. | `200` (JSON; **not** a redirect) | Aggregated status, subsystem checks, billing DLQ metrics, protocol info, goodhart/audit/relayer health |

## Migration guidance for legacy callers (#218)

An older comment described `GET /health` as a `301` redirect to `/healthz`.
That was never the implemented behavior — `/health` returns the full JSON
diagnostic document. Callers that only need liveness should use `/healthz`
directly; callers gating deploys/rotation on dependency readiness should use
`/health/deps` and honor its `503`. Nothing forwards; configure monitors
against the specific route with the semantics you need.
