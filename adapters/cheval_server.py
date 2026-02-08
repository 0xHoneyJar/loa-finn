#!/usr/bin/env python3
"""
cheval_server.py — Cheval HTTP Sidecar (SDD §4.1, T-1.2)

FastAPI application wrapping the existing cheval.py core pipeline.
Binds to 127.0.0.1:{CHEVAL_PORT} (default: 3001).

Endpoints:
  POST /invoke        — Blocking completion (delegates to cheval.py)
  POST /invoke/stream — Streaming completion (Sprint 2 — returns 501)
  GET  /healthz       — Liveness probe
  GET  /readyz        — Readiness probe

Security:
  HMACVerificationMiddleware on all non-GET routes.
  Phase 3 canonical format: method + "\\n" + path + "\\n" + SHA256(body) + ...
  Nonce replay protection via LRU cache (Sprint 1; Redis SETNX in Sprint 2).
"""

import asyncio
import hashlib
import hmac as hmac_mod
import json
import os
import random
import sys
import time
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Any, Optional

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

# Add adapters/ directory to path so we can import cheval.py directly
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cheval import (  # noqa: E402
    ChevalError,
    build_openai_request,
    normalize_response,
)

# --- Configuration ---

CHEVAL_PORT = int(os.environ.get("CHEVAL_PORT", "3001"))
CHEVAL_HMAC_SECRET = os.environ.get("CHEVAL_HMAC_SECRET", "")
CHEVAL_HMAC_SECRET_PREV = os.environ.get("CHEVAL_HMAC_SECRET_PREV", "")
CHEVAL_HMAC_SKEW_SECONDS = float(os.environ.get("CHEVAL_HMAC_SKEW_SECONDS", "30"))
NONCE_CACHE_MAX_SIZE = int(os.environ.get("CHEVAL_NONCE_CACHE_SIZE", "10000"))

START_TIME = time.monotonic()


# --- LRU Nonce Cache ---


class LRUNonceCache:
    """LRU cache for nonce replay protection.

    Sprint 1: in-process only (sufficient for single-replica).
    Sprint 2: Redis SETNX upgrade via T-2.7.
    """

    def __init__(self, max_size: int = 10000):
        self._cache: OrderedDict[str, float] = OrderedDict()
        self._max_size = max_size

    def check_and_add(self, nonce: str, ttl_seconds: float) -> bool:
        """Check if nonce exists, add if not.

        Returns True if nonce is NEW (allowed).
        Returns False if nonce already SEEN (replay detected).
        """
        now = time.monotonic()
        self._evict_expired(now)

        if nonce in self._cache:
            return False  # Replay detected

        self._cache[nonce] = now + ttl_seconds

        # Evict oldest if over capacity
        while len(self._cache) > self._max_size:
            self._cache.popitem(last=False)

        return True

    def _evict_expired(self, now: float) -> None:
        """Remove expired entries from the front of the ordered dict."""
        expired = []
        for nonce, expiry in self._cache.items():
            if now > expiry:
                expired.append(nonce)
            else:
                break  # OrderedDict preserves insertion order
        for nonce in expired:
            del self._cache[nonce]

    def clear(self) -> None:
        self._cache.clear()

    @property
    def size(self) -> int:
        return len(self._cache)


# --- HMAC Verification (Phase 3 format) ---


def build_canonical_phase3(
    method: str,
    path: str,
    body: bytes,
    issued_at: str,
    nonce: str,
    trace_id: str,
) -> str:
    """Build Phase 3 canonical string (endpoint-bound, newline-delimited).

    Must match TypeScript hmac.ts buildCanonical().
    """
    body_hash = hashlib.sha256(body).hexdigest()
    return f"{method}\n{path}\n{body_hash}\n{issued_at}\n{nonce}\n{trace_id}"


def verify_hmac_phase3(
    method: str,
    path: str,
    body: bytes,
    signature: str,
    nonce: str,
    trace_id: str,
    issued_at: str,
    secret: str,
    secret_prev: str = "",
    skew_seconds: float = 30.0,
) -> bool:
    """Verify HMAC-SHA256 using Phase 3 canonical format.

    Supports dual-secret rotation: tries current first, then previous.
    """
    # Clock skew check
    try:
        issued = datetime.fromisoformat(issued_at.replace("Z", "+00:00"))
        delta = abs((datetime.now(timezone.utc) - issued).total_seconds())
        if delta > skew_seconds:
            return False
    except (ValueError, TypeError):
        return False

    canonical = build_canonical_phase3(method, path, body, issued_at, nonce, trace_id)

    # Try current secret
    expected = hmac_mod.new(
        secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    if hmac_mod.compare_digest(signature, expected):
        return True

    # Try previous secret for rotation
    if secret_prev:
        expected_prev = hmac_mod.new(
            secret_prev.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256
        ).hexdigest()
        if hmac_mod.compare_digest(signature, expected_prev):
            return True

    return False


# --- Nonce Cache (module-level singleton) ---

nonce_cache = LRUNonceCache(max_size=NONCE_CACHE_MAX_SIZE)


# --- HMAC Middleware ---


class HMACVerificationMiddleware(BaseHTTPMiddleware):
    """Verify HMAC signature on all non-GET requests.

    GET requests (/healthz, /readyz) bypass verification.
    All POST routes require valid HMAC headers.
    """

    async def dispatch(self, request: Request, call_next: Any) -> Response:
        if request.method == "GET":
            return await call_next(request)

        if not CHEVAL_HMAC_SECRET:
            return JSONResponse(
                status_code=500,
                content={"error": "HMAC_NOT_CONFIGURED", "message": "CHEVAL_HMAC_SECRET not set"},
            )

        # Extract HMAC headers
        signature = request.headers.get("x-cheval-signature", "")
        nonce = request.headers.get("x-cheval-nonce", "")
        issued_at = request.headers.get("x-cheval-issued-at", "")
        trace_id = request.headers.get("x-cheval-trace-id", "")

        if not all([signature, nonce, issued_at, trace_id]):
            return JSONResponse(
                status_code=403,
                content={"error": "HMAC_MISSING_HEADERS", "message": "Missing required HMAC headers"},
            )

        # Read body for verification
        body = await request.body()

        # Verify signature
        valid = verify_hmac_phase3(
            method=request.method,
            path=request.url.path,
            body=body,
            signature=signature,
            nonce=nonce,
            trace_id=trace_id,
            issued_at=issued_at,
            secret=CHEVAL_HMAC_SECRET,
            secret_prev=CHEVAL_HMAC_SECRET_PREV,
            skew_seconds=CHEVAL_HMAC_SKEW_SECONDS,
        )

        if not valid:
            return JSONResponse(
                status_code=403,
                content={"error": "HMAC_INVALID", "message": "HMAC signature verification failed"},
            )

        # Nonce replay check
        nonce_ttl = CHEVAL_HMAC_SKEW_SECONDS * 2
        if not nonce_cache.check_and_add(nonce, nonce_ttl):
            return JSONResponse(
                status_code=403,
                content={"error": "REPLAY_DETECTED", "message": "Nonce already used"},
            )

        return await call_next(request)


# --- Provider Pool Manager ---


class ProviderPoolManager:
    """Per-provider httpx.AsyncClient pool.

    Pools created lazily on first request to each provider.
    Each pool: max_connections=20, max_keepalive_connections=10.
    """

    def __init__(self) -> None:
        self._pools: dict[str, httpx.AsyncClient] = {}

    def get_or_create(
        self,
        provider_name: str,
        base_url: str,
        connect_timeout_ms: int = 5000,
        read_timeout_ms: int = 60000,
        total_timeout_ms: int = 300000,
    ) -> httpx.AsyncClient:
        if provider_name in self._pools:
            return self._pools[provider_name]

        timeout = httpx.Timeout(
            connect=connect_timeout_ms / 1000.0,
            read=read_timeout_ms / 1000.0,
            write=30.0,
            pool=total_timeout_ms / 1000.0,
        )
        limits = httpx.Limits(
            max_connections=20,
            max_keepalive_connections=10,
        )

        client = httpx.AsyncClient(
            base_url=base_url,
            timeout=timeout,
            limits=limits,
        )
        self._pools[provider_name] = client
        return client

    async def close_all(self) -> None:
        """Close all connection pools."""
        for client in self._pools.values():
            await client.aclose()
        self._pools.clear()


# --- Async Retry ---

NON_RETRYABLE_STATUS = {400, 401, 403, 404}


async def invoke_with_retry_async(
    client: httpx.AsyncClient,
    url: str,
    headers: dict[str, str],
    body: dict[str, Any],
    retry_config: dict[str, Any],
    trace_id: str,
) -> httpx.Response:
    """Async version of cheval.invoke_with_retry for the sidecar event loop."""
    max_retries = retry_config.get("max_retries", 3)
    base_delay = retry_config.get("base_delay_ms", 1000) / 1000.0
    max_delay = retry_config.get("max_delay_ms", 30000) / 1000.0
    jitter_pct = retry_config.get("jitter_percent", 25) / 100.0
    retryable_codes = set(retry_config.get("retryable_status_codes", [429, 500, 502, 503, 504]))

    last_error: Optional[ChevalError] = None

    for attempt in range(max_retries + 1):
        if attempt > 0:
            delay = min(base_delay * (2 ** (attempt - 1)), max_delay)
            jitter = delay * jitter_pct * (random.random() * 2 - 1)
            actual_delay = max(0, delay + jitter)
            print(
                f"[cheval-sidecar] RETRY {trace_id}: "
                f"attempt {attempt + 1}/{max_retries + 1}, delay {actual_delay:.2f}s",
                flush=True,
            )
            await asyncio.sleep(actual_delay)

        try:
            response = await client.post(url, json=body, headers=headers)

            if response.status_code == 200:
                return response

            error_text = response.text[:200] if response.text else "(empty body)"

            if response.status_code in NON_RETRYABLE_STATUS:
                raise ChevalError(
                    code="provider_error",
                    message=f"HTTP {response.status_code}: {error_text}",
                    status_code=response.status_code,
                    retryable=False,
                )

            if response.status_code in retryable_codes:
                last_error = ChevalError(
                    code="provider_error",
                    message=f"HTTP {response.status_code}: {error_text}",
                    status_code=response.status_code,
                    retryable=True,
                )
                if attempt < max_retries:
                    continue
                raise last_error

            raise ChevalError(
                code="provider_error",
                message=f"HTTP {response.status_code}: {error_text}",
                status_code=response.status_code,
                retryable=False,
            )

        except httpx.TimeoutException as e:
            last_error = ChevalError(
                code="network_error",
                message=f"Request timed out: {e}",
                retryable=True,
            )
            if attempt < max_retries:
                continue
            raise last_error

        except httpx.ConnectError as e:
            last_error = ChevalError(
                code="network_error",
                message=f"Connection failed: {e}",
                retryable=True,
            )
            if attempt < max_retries:
                continue
            raise last_error

        except ChevalError:
            raise

        except Exception as e:
            raise ChevalError(
                code="network_error",
                message=f"Unexpected error: {e}",
                retryable=False,
            )

    if last_error:
        raise last_error
    raise ChevalError(code="network_error", message="All retries exhausted", retryable=False)


# --- Application ---

app = FastAPI(title="Cheval Sidecar", docs_url=None, redoc_url=None)
app.add_middleware(HMACVerificationMiddleware)

pool_manager = ProviderPoolManager()


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    """Liveness probe. Process alive, event loop responsive."""
    return {
        "status": "alive",
        "uptime_s": round(time.monotonic() - START_TIME, 2),
    }


@app.get("/readyz")
async def readyz() -> dict[str, Any]:
    """Readiness probe. Returns 200 if sidecar is ready.

    Sprint 1: simple liveness check.
    Sprint 2: adds provider connectivity check.
    """
    return {
        "status": "ready",
        "uptime_s": round(time.monotonic() - START_TIME, 2),
        "nonce_cache_size": nonce_cache.size,
    }


@app.post("/invoke")
async def invoke(request: Request) -> JSONResponse:
    """Blocking completion. Delegates to cheval.py core pipeline.

    1. Parse ChevalRequest from body
    2. Get/create provider connection pool
    3. Build OpenAI-compatible request (cheval.build_openai_request)
    4. Send with async retry
    5. Normalize response (cheval.normalize_response)
    6. Return CompletionResult
    """
    body = await request.body()
    try:
        cheval_request = json.loads(body)
    except json.JSONDecodeError:
        return JSONResponse(
            status_code=400,
            content={"error": "INVALID_JSON", "message": "Request body is not valid JSON"},
        )

    provider = cheval_request.get("provider", {})
    provider_name = provider.get("name", "unknown")
    base_url = provider.get("base_url", "")
    api_key = provider.get("api_key", "")

    if not base_url or not api_key:
        return JSONResponse(
            status_code=400,
            content={"error": "MISSING_PROVIDER", "message": "Missing provider base_url or api_key"},
        )

    trace_id = cheval_request.get("metadata", {}).get("trace_id", "")
    provider_type = provider.get("type", "openai")
    retry_config = cheval_request.get("retry", {})

    openai_body = build_openai_request(cheval_request)
    url = "/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "X-Request-ID": trace_id,
    }

    client = pool_manager.get_or_create(
        provider_name=provider_name,
        base_url=base_url.rstrip("/"),
        connect_timeout_ms=provider.get("connect_timeout_ms", 5000),
        read_timeout_ms=provider.get("read_timeout_ms", 60000),
        total_timeout_ms=provider.get("total_timeout_ms", 300000),
    )

    start_time = time.monotonic()
    try:
        response = await invoke_with_retry_async(
            client, url, headers, openai_body, retry_config, trace_id,
        )
    except ChevalError as e:
        return JSONResponse(status_code=502, content=e.to_dict())

    latency_ms = (time.monotonic() - start_time) * 1000

    try:
        raw_response = response.json()
    except json.JSONDecodeError:
        return JSONResponse(
            status_code=502,
            content={
                "error": "ChevalError",
                "code": "provider_error",
                "message": f"Non-JSON response from provider: {response.text[:200]}",
            },
        )

    result = normalize_response(raw_response, provider_type, trace_id, latency_ms)
    return JSONResponse(content=result)


@app.post("/invoke/stream")
async def invoke_stream(request: Request) -> JSONResponse:
    """Streaming completion (Sprint 2 — T-2.1, T-2.3). Returns 501 in Sprint 1."""
    return JSONResponse(
        status_code=501,
        content={"error": "NOT_IMPLEMENTED", "message": "Streaming not available until Sprint 2"},
    )


# --- Startup/Shutdown ---


@app.on_event("startup")
async def startup() -> None:
    """Log config on startup (no secrets)."""
    print(f"[cheval-sidecar] Started on 127.0.0.1:{CHEVAL_PORT}", flush=True)
    print(f"[cheval-sidecar] HMAC: {'configured' if CHEVAL_HMAC_SECRET else 'NOT CONFIGURED'}", flush=True)
    print(f"[cheval-sidecar] Nonce cache max: {NONCE_CACHE_MAX_SIZE}", flush=True)


@app.on_event("shutdown")
async def shutdown() -> None:
    """Drain all connection pools."""
    print("[cheval-sidecar] Shutting down, draining pools...", flush=True)
    await pool_manager.close_all()
    print("[cheval-sidecar] Shutdown complete", flush=True)
