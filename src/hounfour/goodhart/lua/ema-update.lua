-- src/hounfour/goodhart/lua/ema-update.lua — Atomic EMA Update (SDD §4.1.1)
--
-- KEYS[1] = finn:ema:{nftId}:{poolId}:{routingKey}
-- ARGV[1] = new observation value
-- ARGV[2] = observation timestamp (unix millis)
-- ARGV[3] = halfLifeMs
-- ARGV[4] = TTL seconds
-- ARGV[5] = event hash (for inline idempotency check)

-- 1. GET current state (idempotency is checked inline via lastEventHash)
local raw = redis.call("GET", KEYS[1])
local value = tonumber(ARGV[1])
local timestamp = tonumber(ARGV[2])
local halfLife = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

if raw == false then
  -- Cold start: first observation
  local state = cjson.encode({ema = value, lastTimestamp = timestamp, sampleCount = 1, lastEventHash = ARGV[5]})
  redis.call("SET", KEYS[1], state, "EX", ttl)
  return state
end

local state = cjson.decode(raw)

-- 2. Idempotency check: compare against last-seen event hash stored in EMA state
-- This is O(1) per key — no separate idempotency keys, no unbounded growth
if state.lastEventHash == ARGV[5] then
  return raw  -- Duplicate event, return existing state
end

-- 3. Out-of-order check
if timestamp < state.lastTimestamp then
  return raw  -- Drop stale event
end

-- 4. Compute alpha and new EMA
local dt = timestamp - state.lastTimestamp
local alpha = 1 - math.exp(-0.693147 * dt / halfLife)  -- ln(2) ≈ 0.693147
local newEma = alpha * value + (1 - alpha) * state.ema

-- 5. SET new state (include lastEventHash for idempotency)
local newState = cjson.encode({
  ema = newEma,
  lastTimestamp = timestamp,
  sampleCount = state.sampleCount + 1,
  lastEventHash = ARGV[5]
})
redis.call("SET", KEYS[1], newState, "EX", ttl)
return newState
