-- x402_verify_atomic.lua — Atomic nonce consumption + replay protection (Sprint 2 T2.6)
--
-- Inputs: KEYS[1] = x402:challenge:{nonce}
--         KEYS[2] = x402:replay:{tx_hash}
--         ARGV[1] = replay TTL (86400 = 24h)
--         ARGV[2] = tx_hash (stored as replay value)
--
-- Returns: 0 = success (nonce consumed, replay key set)
--          1 = nonce not found (expired or never existed)
--          2 = tx_hash already used (replay attempt)
--          3 = nonce already consumed (concurrent request won race)

-- Step A: Check nonce exists and is unconsumed
local challenge = redis.call('GET', KEYS[1])
if not challenge then return 1 end

-- Step B: Check nonce not already consumed (atomic guard against concurrent requests)
local consumed = redis.call('GET', KEYS[1] .. ':consumed')
if consumed then return 3 end

-- Step C: Check tx_hash replay
local replay = redis.call('EXISTS', KEYS[2])
if replay == 1 then return 2 end

-- Step D: Atomically mark nonce consumed + set replay key + clean up challenge
redis.call('SET', KEYS[1] .. ':consumed', '1', 'EX', 300)
redis.call('SET', KEYS[2], ARGV[2], 'EX', tonumber(ARGV[1]))
redis.call('DEL', KEYS[1])

return 0
