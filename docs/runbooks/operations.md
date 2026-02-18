# loa-finn Operational Runbooks

> Sprint 10 Task 10.4 — Operational procedures for closed beta.

---

## 1. Treasury Compromise

**Indicators**: Unauthorized USDC transfers from treasury address.

### Immediate Actions

1. **Freeze mints**: Disable credit purchase via feature flag
   ```
   POST /api/v1/admin/feature-flags
   { "flag": "credits", "enabled": false }
   ```

2. **Disable x402**: Stop accepting new payments
   ```
   POST /api/v1/admin/feature-flags
   { "flag": "x402", "enabled": false }
   ```

3. **Rotate treasury address**:
   - Update SSM Parameter: `/loa-finn/production/TREASURY_ADDRESS`
   - Redeploy ECS service
   - Update x402 quote cache: restart service or wait 60s cache expiry

4. **Audit recent mints**: Review WAL entries for `credit_mint` events in the last 24h

### Recovery

- New treasury address verified
- Feature flags re-enabled one at a time
- Monitor for 1 hour after recovery

---

## 2. DLQ Overflow

**Indicators**: `billing_pending_reconciliation_count > 10` alarm, entries in `billing:dlq:poison` stream.

### Immediate Actions

1. **Circuit breaker**: Billing automatically circuit-breaks after DLQ overflow. Verify:
   - Conservation guard in `degraded` state
   - New reserves return 503

2. **Investigate root cause**:
   - Check arrakis health: `curl https://arrakis.honeyjar.xyz/health`
   - Check Redis connectivity
   - Review DLQ poison messages for error patterns

3. **Admin resolution**: For each poisoned entry:
   - Verify the billing WAL entry exists
   - If arrakis confirms the finalize succeeded: mark as FINALIZE_ACKED
   - If arrakis has no record: void the entry, release held credits

### Recovery

- Clear poison queue after resolution
- Verify conservation guard transitions back to `ready`
- Monitor DLQ depth for 1 hour

---

## 3. Conservation Guard Failure

**Indicators**: `conservation_guard_state = 0` metric, HARD_FAIL logs.

### Immediate Actions

1. **DO NOT set EVALUATOR_BYPASS=true** unless you understand the implications. Bypass disables ALL invariant checking.

2. **Identify the failing invariant** from logs:
   - `budget_conservation`: Spending exceeds limits
   - `cost_non_negative`: Negative cost detected (likely a bug)
   - `reserve_within_allocation`: Reserve exceeds allocation
   - `entitlement_valid`: Entitlement state invalid
   - `rate_consistency`: Exchange rate drift between reserve and commit

3. **If evaluator compilation failure** (state=degraded):
   - Check for JavaScript syntax errors in constraint expressions
   - Review recent deployments for regression
   - Evaluator will auto-retry every 3 seconds

### Recovery

- Fix root cause (code fix or data correction)
- Conservation guard auto-recovers when evaluator compiles successfully
- Verify `circuit=closed` log entry after recovery

---

## 4. Gate Rollback

### Rollback to Previous Gate

| Current Gate | Rollback To | Flags to Disable |
|--------------|-------------|------------------|
| Gate 4 (Launch) | Gate 2 | `x402` |
| Gate 2 (Warmup) | Gate 1 | `nft`, `onboarding` |
| Gate 1 (Ignition) | Gate 0 | `credits` |
| Gate 0 (Smoke) | Off | `billing` |

```bash
# Example: Rollback from Gate 4 to Gate 2
curl -X POST https://loa-finn.honeyjar.xyz/api/v1/admin/feature-flags \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"flag": "x402", "enabled": false}'
```

### Verification

After rollback, verify:
1. Disabled feature's endpoints return 503
2. Previous gate's features still work
3. No error spike in CloudWatch

---

## 5. Redis Failure

**Indicators**: Redis connection errors, ETIMEDOUT in logs.

### Immediate Actions

1. **Check ElastiCache status**: AWS Console → ElastiCache → loa-finn cluster

2. **If primary node failure**: Automatic failover to replica (Multi-AZ). Monitor:
   - Failover completion time (typically < 60s)
   - Application reconnection

3. **If complete cluster failure**:
   - All billing operations fail-closed (503)
   - x402 nonce protection fails-closed (deny all x402)
   - Conversations cached in Redis are lost (R2 backup has snapshots)

### Recovery: WAL Rebuild

1. **Restart ECS service** — WAL replay engine runs on startup:
   - Replays all WAL entries
   - Rebuilds Redis balance state
   - Rebuilds used payment IDs (x402 nonce protection)

2. **Verify balances**: Compare Redis balances to WAL-derived balances

3. **Verify nonce protection**: Used payment IDs restored from WAL

### Important

- WAL is the source of truth, not Redis
- Redis is a derived cache rebuilt from WAL
- R2 has conversation snapshots (not real-time)

---

## 6. WAL Single-Writer Violation

**Indicators**: `ecs_desired_count_drift` alarm, `CRITICAL: lock conflict` in logs.

### Immediate Actions

1. **NEVER scale desiredCount above 1** — WAL corruption risk

2. **If second instance started**:
   - Second instance will fail to acquire writer lock
   - Returns 503 on all billing endpoints (fail-closed)
   - First instance continues operating normally

3. **Scale back to 1**: Update ECS service desired count

### Future

WAL single-writer is a beta constraint. Future scaling requires:
- Leader election protocol
- WAL partitioning
- Or migration to distributed WAL (e.g., Kafka)
