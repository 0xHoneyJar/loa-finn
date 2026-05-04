#!/usr/bin/env bash
#
# wait-healthy.sh
#
# Polls finn and freeside health endpoints with exponential backoff.
# Exits 0 when all services are healthy, exits 1 on timeout.
#
# Usage:
#   ./tests/e2e/wait-healthy.sh

set -euo pipefail

FINN_URL="http://localhost:3001/health"
FREESIDE_URL="http://localhost:3002/v1/health"
TIMEOUT_SECONDS=60

finn_healthy=false
freeside_healthy=false

backoff=1
elapsed=0

echo "[wait-healthy] Waiting for services to become healthy (timeout: ${TIMEOUT_SECONDS}s)..."

while (( elapsed < TIMEOUT_SECONDS )); do
  # Check finn
  if [ "$finn_healthy" = false ]; then
    if curl -sf --max-time 3 "$FINN_URL" > /dev/null 2>&1; then
      finn_healthy=true
      echo "[wait-healthy] finn is healthy (${elapsed}s elapsed)"
    fi
  fi

  # Check freeside
  if [ "$freeside_healthy" = false ]; then
    if curl -sf --max-time 3 "$FREESIDE_URL" > /dev/null 2>&1; then
      freeside_healthy=true
      echo "[wait-healthy] freeside is healthy (${elapsed}s elapsed)"
    fi
  fi

  # All healthy — exit success
  if [ "$finn_healthy" = true ] && [ "$freeside_healthy" = true ]; then
    echo "[wait-healthy] All services healthy after ${elapsed}s"
    exit 0
  fi

  # Exponential backoff: 1, 2, 4, 8, 16, 16, 16, ...
  sleep_time=$backoff
  # Clamp so we don't overshoot the timeout
  if (( elapsed + sleep_time > TIMEOUT_SECONDS )); then
    sleep_time=$(( TIMEOUT_SECONDS - elapsed ))
  fi

  echo "[wait-healthy] Retrying in ${sleep_time}s (elapsed: ${elapsed}s)..."
  sleep "$sleep_time"
  elapsed=$(( elapsed + sleep_time ))

  # Cap backoff at 16s
  if (( backoff < 16 )); then
    backoff=$(( backoff * 2 ))
  fi
done

# Timeout — report which services failed
echo ""
echo "[wait-healthy] TIMEOUT after ${TIMEOUT_SECONDS}s. Service status:"
if [ "$finn_healthy" = false ]; then
  echo "  FAILED: finn      — $FINN_URL did not respond"
fi
if [ "$freeside_healthy" = false ]; then
  echo "  FAILED: freeside  — $FREESIDE_URL did not respond"
fi

exit 1
