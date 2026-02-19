#!/usr/bin/env bash
# scripts/test-integration.sh — Docker-Based Integration Test Runner (Sprint 13 Task 13.3)
#
# Starts Docker Redis, runs @integration tagged tests, tears down.
# Usage:
#   ./scripts/test-integration.sh           # Run all integration tests
#   ./scripts/test-integration.sh --keep    # Keep Docker running after tests

set -euo pipefail

COMPOSE_FILE="tests/docker-compose.test.yml"
KEEP_RUNNING=false

# Parse flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP_RUNNING=true; shift ;;
    *) echo "Unknown flag: $1"; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

cleanup() {
  if [[ "$KEEP_RUNNING" == "false" ]]; then
    echo "[integration] Tearing down Docker services..."
    docker compose -f "$COMPOSE_FILE" down -v --remove-orphans 2>/dev/null || true
  fi
}

trap cleanup EXIT

# ---------------------------------------------------------------------------
# Start
# ---------------------------------------------------------------------------

echo "[integration] Starting Docker Redis..."
docker compose -f "$COMPOSE_FILE" up -d --wait

# Wait for Redis health
echo "[integration] Waiting for Redis to be ready..."
RETRIES=0
MAX_RETRIES=30
until docker compose -f "$COMPOSE_FILE" exec -T redis-test redis-cli ping 2>/dev/null | grep -q PONG; do
  RETRIES=$((RETRIES + 1))
  if [[ $RETRIES -ge $MAX_RETRIES ]]; then
    echo "[integration] ERROR: Redis did not become ready after ${MAX_RETRIES}s"
    exit 1
  fi
  sleep 1
done
echo "[integration] Redis ready."

# ---------------------------------------------------------------------------
# Run Tests
# ---------------------------------------------------------------------------

echo "[integration] Running @integration tests..."
REDIS_TEST_URL="redis://localhost:6381" npx vitest run --testPathPattern='integration' 2>&1
TEST_EXIT=$?

echo ""
if [[ $TEST_EXIT -eq 0 ]]; then
  echo "[integration] All integration tests passed."
else
  echo "[integration] Some integration tests failed (exit code: $TEST_EXIT)."
fi

exit $TEST_EXIT
