# Shadow to Enabled Graduation Runbook

**Purpose:** Step-by-step procedure for promoting loa-finn routing from shadow mode to enabled mode.

**Prerequisite:** All exit criteria must be met for a continuous 48-hour window on staging (armitage).

---

## 1. Exit Criteria

All criteria must be met for **48 continuous hours** before graduation is approved.

| # | Metric | Threshold | Prometheus Query |
|---|--------|-----------|-----------------|
| 1 | Shadow overhead p99 | < 10ms | `histogram_quantile(0.99, rate(finn_routing_duration_seconds_bucket{path="shadow"}[5m]))` |
| 2 | Shadow error rate | < 0.1% | `rate(finn_goodhart_timeout_total[1h]) / rate(finn_shadow_total[1h]) * 100` |
| 3 | Divergence rate | Stable (not trending up) | `rate(finn_shadow_diverged_total[1h]) / rate(finn_shadow_total[1h]) * 100` |
| 4 | Init failure rate | 0 | `finn_goodhart_init_failed_total` |
| 5 | KillSwitch state | "normal" | `finn_killswitch_state{state="normal"} == 1` |
| 6 | Scoring failure rate | < 1% | `rate(finn_reputation_scoring_failed_total[1h]) / rate(finn_shadow_total[1h]) * 100` |

### Validation Commands

Check all criteria at once:

```bash
# Shadow overhead p99 (should be < 0.010)
curl -s http://prometheus:9090/api/v1/query \
  --data-urlencode 'query=histogram_quantile(0.99, rate(finn_routing_duration_seconds_bucket{path="shadow"}[5m]))' \
  | jq '.data.result[0].value[1]'

# Shadow error rate (should be < 0.001)
curl -s http://prometheus:9090/api/v1/query \
  --data-urlencode 'query=rate(finn_goodhart_timeout_total[1h]) / rate(finn_shadow_total[1h])' \
  | jq '.data.result[0].value[1]'

# Divergence rate trend (should be flat or decreasing)
curl -s http://prometheus:9090/api/v1/query_range \
  --data-urlencode 'query=rate(finn_shadow_diverged_total[1h]) / rate(finn_shadow_total[1h])' \
  --data-urlencode 'start=-48h' \
  --data-urlencode 'end=now' \
  --data-urlencode 'step=1h' \
  | jq '.data.result[0].values'

# Init failure count (should be 0)
curl -s http://prometheus:9090/api/v1/query \
  --data-urlencode 'query=finn_goodhart_init_failed_total' \
  | jq '.data.result[0].value[1]'

# KillSwitch state (should show "normal")
curl -s http://prometheus:9090/api/v1/query \
  --data-urlencode 'query=finn_killswitch_state' \
  | jq '.data.result'

# Scoring failure rate (should be < 0.01)
curl -s http://prometheus:9090/api/v1/query \
  --data-urlencode 'query=rate(finn_reputation_scoring_failed_total[1h]) / rate(finn_shadow_total[1h])' \
  | jq '.data.result[0].value[1]'
```

---

## 2. Promotion Procedure

### Pre-Deploy Checklist

- [ ] `FINN_REPUTATION_ROUTING` is **explicitly set** in SSM/env (not relying on defaults). As of cycle-036 T-4.4, the default is `"disabled"` — omitting the variable will **not** enable shadow mode.
- [ ] All exit criteria met for 48 continuous hours (see below)
- [ ] KillSwitch state verified as `"normal"` in Redis

### Step 1: Final exit criteria validation

Run the exit criteria checks above. All must pass. Record the timestamp and values in the ops channel.

### Step 2: Update SSM parameter

```bash
aws ssm put-parameter \
  --name "/loa-finn/armitage/FINN_REPUTATION_ROUTING" \
  --value "enabled" \
  --type "String" \
  --overwrite \
  --region us-east-1
```

### Step 3: Redeploy ECS service

The ECS task picks up SSM values at container startup, so a redeployment is required:

```bash
aws ecs update-service \
  --cluster honeyjar-armitage \
  --service loa-finn-armitage \
  --force-new-deployment \
  --region us-east-1
```

### Step 4: Monitor for 1 hour

Watch the following dashboards and metrics:

```bash
# Confirm routing mode has changed
curl -sf https://finn-armitage.arrakis.community/health | jq '.routingState'
# Expected: "enabled"

# Watch enabled-mode routing metrics
watch -n 10 'curl -sf https://finn-armitage.arrakis.community/metrics | grep finn_goodhart_routing_mode'

# Monitor error rates
watch -n 30 'curl -sf https://finn-armitage.arrakis.community/metrics | grep -E "finn_goodhart_(timeout|scoring_failed)"'
```

### Step 5: Post-graduation monitoring

- Keep shadow metrics active for 7 days (they will read zero, confirming mode transition)
- Monitor `finn_goodhart_routing_mode{mode="enabled"}` gauge is 1
- Watch for any KillSwitch activations: `finn_killswitch_activated_total`

---

## 3. KillSwitch Command

Emergency revert to deterministic routing. Takes effect within **1 second** (no redeployment required).

### Activate KillSwitch (force deterministic routing)

```bash
# Via Redis CLI
redis-cli -u "$REDIS_URL" SET "finn:killswitch:mode" "kill"

# Via AWS Systems Manager (if Redis not directly accessible)
aws ssm send-command \
  --document-name "AWS-RunShellScript" \
  --targets "Key=tag:Service,Values=loa-finn" \
  --parameters 'commands=["redis-cli -u $REDIS_URL SET finn:killswitch:mode kill"]' \
  --region us-east-1
```

**Redis key:** `finn:killswitch:mode`
**Kill value:** `"kill"`
**Normal value:** `"normal"`

### Deactivate KillSwitch (resume configured mode)

```bash
redis-cli -u "$REDIS_URL" SET "finn:killswitch:mode" "normal"
```

### Verify KillSwitch state

```bash
redis-cli -u "$REDIS_URL" GET "finn:killswitch:mode"
# Expected: "kill" or "normal"

# Confirm via health endpoint
curl -sf https://finn-armitage.arrakis.community/health | jq '.killSwitchState'
```

---

## 4. Rollback Paths

Three tiers based on severity. Use the fastest method that matches the situation.

### Tier 1: P0 — Routing broken (< 1 second)

**Symptom:** 5xx errors, routing failures, request timeouts.
**Method:** KillSwitch via Redis.

```bash
redis-cli -u "$REDIS_URL" SET "finn:killswitch:mode" "kill"
```

**Effect:** Immediate fallback to deterministic routing. No redeployment. All in-flight requests complete with deterministic path. KillSwitch takes precedence over all other routing configuration.

**Recovery:** Investigate root cause. Once resolved:
```bash
redis-cli -u "$REDIS_URL" SET "finn:killswitch:mode" "normal"
```

### Tier 2: P1 — Degraded quality (~5 minutes)

**Symptom:** Scoring quality degraded, divergence rate spiking, but no hard failures.
**Method:** SSM parameter update + ECS redeploy.

```bash
# Revert to shadow mode
aws ssm put-parameter \
  --name "/loa-finn/armitage/FINN_REPUTATION_ROUTING" \
  --value "shadow" \
  --type "String" \
  --overwrite \
  --region us-east-1

# Force new deployment to pick up change
aws ecs update-service \
  --cluster honeyjar-armitage \
  --service loa-finn-armitage \
  --force-new-deployment \
  --region us-east-1

# Wait for stability
aws ecs wait services-stable \
  --cluster honeyjar-armitage \
  --services loa-finn-armitage \
  --region us-east-1
```

**Effect:** Returns to shadow mode. Reputation scoring continues (read-only) but deterministic results are returned.

### Tier 3: P2 — Non-urgent (~30 minutes)

**Symptom:** Minor quality issues, needs investigation but not urgent.
**Method:** SSM parameter update, deployed on next regular release.

```bash
# Disable reputation routing entirely
aws ssm put-parameter \
  --name "/loa-finn/armitage/FINN_REPUTATION_ROUTING" \
  --value "disabled" \
  --type "String" \
  --overwrite \
  --region us-east-1
```

**Effect:** On next deployment, Goodhart stack is not initialized. Zero overhead.

---

## 5. Decision Tree

```
Is routing broken (5xx, timeouts)?
  YES → Tier 1: KillSwitch (redis SET finn:killswitch:mode kill)
  NO  → Is quality degraded (divergence spike, scoring errors)?
          YES → Tier 2: SSM → shadow + redeploy
          NO  → Is investigation needed?
                  YES → Tier 3: SSM → disabled, next deploy
                  NO  → Continue monitoring
```

---

## 6. Communication Template

Post to ops channel before and after graduation:

**Before:**
> Starting shadow→enabled graduation for loa-finn-armitage.
> All exit criteria met for 48h. SSM update and redeploy in progress.
> Monitoring for 1 hour. KillSwitch ready.

**After (success):**
> Graduation complete. loa-finn-armitage now running in enabled mode.
> Monitoring continues for 7 days. KillSwitch remains available.

**Rollback:**
> [P0/P1/P2] Rolling back loa-finn-armitage to [shadow/disabled].
> Reason: [brief description].
> ETA for resolution: [time estimate].
