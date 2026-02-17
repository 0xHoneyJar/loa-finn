#!/usr/bin/env bash
# scripts/oracle-keys.sh — Oracle API key management (SDD §3.3, Sprint 4 Task 4.5)
# Usage: ./scripts/oracle-keys.sh create|revoke|list [options]

set -euo pipefail

REDIS_URL="${REDIS_URL:?REDIS_URL required}"
PREFIX_LIVE="dk_live_"
PREFIX_TEST="dk_test_"

case "${1:-}" in
  create)
    owner="${2:?Usage: oracle-keys.sh create <owner> [--test]}"
    prefix="${PREFIX_LIVE}"
    [[ "${3:-}" == "--test" ]] && prefix="${PREFIX_TEST}"

    # Generate 32-byte hex key (64 hex chars)
    raw_key="${prefix}$(openssl rand -hex 32)"
    key_hash=$(echo -n "$raw_key" | sha256sum | cut -d' ' -f1)

    # Store in Redis
    redis-cli -u "$REDIS_URL" HSET "oracle:apikeys:${key_hash}" \
      status active \
      owner "$owner" \
      created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      last_used_at ""

    echo "Created key for ${owner}:"
    echo "  Key:  ${raw_key}"
    echo "  Hash: ${key_hash}"
    echo ""
    echo "IMPORTANT: Store this key securely. It cannot be recovered."
    ;;

  revoke)
    key_hash="${2:?Usage: oracle-keys.sh revoke <key_hash>}"
    redis-cli -u "$REDIS_URL" HSET "oracle:apikeys:${key_hash}" status revoked
    echo "Revoked key: ${key_hash}"
    ;;

  list)
    echo "Oracle API keys:"
    for key in $(redis-cli -u "$REDIS_URL" --scan --pattern "oracle:apikeys:*"); do
      status=$(redis-cli -u "$REDIS_URL" HGET "$key" status)
      owner=$(redis-cli -u "$REDIS_URL" HGET "$key" owner)
      created=$(redis-cli -u "$REDIS_URL" HGET "$key" created_at)
      last_used=$(redis-cli -u "$REDIS_URL" HGET "$key" last_used_at)
      hash=${key#oracle:apikeys:}
      echo "  ${hash:0:12}... | ${status} | ${owner} | created: ${created} | last used: ${last_used:-never}"
    done
    ;;

  *)
    echo "Usage: oracle-keys.sh create|revoke|list"
    echo ""
    echo "Commands:"
    echo "  create <owner> [--test]  Create a new API key (dk_live_ or dk_test_ prefix)"
    echo "  revoke <key_hash>        Revoke an API key by its SHA-256 hash"
    echo "  list                     List all API keys with status"
    echo ""
    echo "Environment:"
    echo "  REDIS_URL  Required. Full redis:// or rediss:// URL"
    exit 1
    ;;
esac
