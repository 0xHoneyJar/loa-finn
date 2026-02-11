#!/usr/bin/env python3
"""
cheval_server_test.py — Cheval HTTP Sidecar tests (SDD §4.1, T-1.2)

Tests HMAC middleware, health endpoints, nonce replay protection,
and /invoke endpoint with mocked provider.

Run: python3 adapters/cheval_server_test.py
"""

import hashlib
import hmac as hmac_mod
import json
import os
import sys
import time
from datetime import datetime, timezone

# Configure env vars BEFORE importing the app (module reads at import time)
os.environ.setdefault("CHEVAL_HMAC_SECRET", "test-secret-for-sidecar-tests!")
os.environ.setdefault("CHEVAL_HMAC_SECRET_PREV", "old-secret-for-rotation-test!")
os.environ.setdefault("CHEVAL_HMAC_SKEW_SECONDS", "30")
os.environ.setdefault("CHEVAL_PORT", "3099")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from starlette.testclient import TestClient
from cheval_server import (
    app,
    nonce_cache,
    build_canonical_phase3,
    LRUNonceCache,
    verify_hmac_phase3,
)

client = TestClient(app)

passed = 0
failed = 0


def test(name: str, fn):
    global passed, failed
    try:
        fn()
        print(f"  PASS  {name}")
        passed += 1
    except Exception as e:
        print(f"  FAIL  {name}")
        print(f"         {e}")
        failed += 1


def assert_eq(actual, expected, msg=""):
    if actual != expected:
        raise AssertionError(f"{msg}: expected {expected!r}, got {actual!r}")


# --- Signing Helper ---

SECRET = os.environ["CHEVAL_HMAC_SECRET"]
SECRET_PREV = os.environ["CHEVAL_HMAC_SECRET_PREV"]


def sign_request(method: str, path: str, body: str, trace_id: str, secret: str = SECRET) -> dict:
    """Sign a request using Phase 3 HMAC format."""
    nonce = os.urandom(16).hex()
    issued_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + \
        f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"
    body_bytes = body.encode("utf-8") if isinstance(body, str) else body
    canonical = build_canonical_phase3(method, path, body_bytes, issued_at, nonce, trace_id)
    signature = hmac_mod.new(
        secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return {
        "x-cheval-signature": signature,
        "x-cheval-nonce": nonce,
        "x-cheval-issued-at": issued_at,
        "x-cheval-trace-id": trace_id,
    }


# --- Health Endpoint Tests ---


def test_healthz_returns_200():
    response = client.get("/healthz")
    assert_eq(response.status_code, 200, "healthz status")
    data = response.json()
    assert_eq(data["status"], "alive", "healthz status field")
    assert "uptime_s" in data, "healthz has uptime_s"


def test_readyz_returns_200():
    response = client.get("/readyz")
    assert_eq(response.status_code, 200, "readyz status")
    data = response.json()
    assert_eq(data["status"], "ready", "readyz status field")


def test_healthz_bypasses_hmac():
    """GET /healthz should work without HMAC headers."""
    response = client.get("/healthz")
    assert_eq(response.status_code, 200, "healthz without HMAC")


def test_readyz_bypasses_hmac():
    """GET /readyz should work without HMAC headers."""
    response = client.get("/readyz")
    assert_eq(response.status_code, 200, "readyz without HMAC")


# --- HMAC Middleware Tests ---


def test_post_without_hmac_returns_403():
    """POST without HMAC headers should be rejected."""
    response = client.post("/invoke", content=b'{"test": true}')
    assert_eq(response.status_code, 403, "missing HMAC status")
    data = response.json()
    assert_eq(data["error"], "HMAC_MISSING_HEADERS", "error code")


def test_post_with_partial_hmac_returns_403():
    """POST with incomplete HMAC headers should be rejected."""
    response = client.post(
        "/invoke",
        content=b'{"test": true}',
        headers={"x-cheval-signature": "abc123"},
    )
    assert_eq(response.status_code, 403, "partial HMAC status")


def test_post_with_invalid_signature_returns_403():
    """POST with wrong signature should be rejected."""
    headers = sign_request("POST", "/invoke", '{"test": true}', "trace-1")
    headers["x-cheval-signature"] = "a" * 64  # Wrong signature
    response = client.post("/invoke", content=b'{"test": true}', headers=headers)
    assert_eq(response.status_code, 403, "invalid signature status")
    data = response.json()
    assert_eq(data["error"], "HMAC_INVALID", "error code")


def test_post_with_expired_timestamp_returns_403():
    """POST with expired issued_at should be rejected."""
    body = '{"test": true}'
    nonce = os.urandom(16).hex()
    issued_at = "2020-01-01T00:00:00.000Z"  # Way in the past
    body_bytes = body.encode("utf-8")
    canonical = build_canonical_phase3("POST", "/invoke", body_bytes, issued_at, nonce, "trace-1")
    signature = hmac_mod.new(
        SECRET.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256
    ).hexdigest()

    headers = {
        "x-cheval-signature": signature,
        "x-cheval-nonce": nonce,
        "x-cheval-issued-at": issued_at,
        "x-cheval-trace-id": "trace-1",
    }
    response = client.post("/invoke", content=body_bytes, headers=headers)
    assert_eq(response.status_code, 403, "expired timestamp status")


def test_post_with_valid_hmac_passes_middleware():
    """POST with valid HMAC should pass middleware (may fail at endpoint level)."""
    body = '{"test": true}'
    headers = sign_request("POST", "/invoke", body, "trace-valid")
    response = client.post("/invoke", content=body.encode("utf-8"), headers=headers)
    # Should NOT be 403 — may be 400 (missing provider) which means HMAC passed
    assert response.status_code != 403, f"Expected non-403, got {response.status_code}"


def test_nonce_replay_returns_403():
    """Reusing the same nonce should be rejected."""
    body = '{"test": true}'
    nonce = os.urandom(16).hex()
    issued_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + \
        f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"
    body_bytes = body.encode("utf-8")
    canonical = build_canonical_phase3("POST", "/invoke", body_bytes, issued_at, nonce, "trace-replay")
    signature = hmac_mod.new(
        SECRET.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256
    ).hexdigest()

    headers = {
        "x-cheval-signature": signature,
        "x-cheval-nonce": nonce,
        "x-cheval-issued-at": issued_at,
        "x-cheval-trace-id": "trace-replay",
    }

    # First request — should pass HMAC
    r1 = client.post("/invoke", content=body_bytes, headers=headers)
    assert r1.status_code != 403, f"First request should pass HMAC, got {r1.status_code}"

    # Second request with same nonce — should be rejected as replay
    r2 = client.post("/invoke", content=body_bytes, headers=headers)
    assert_eq(r2.status_code, 403, "replay status")
    data = r2.json()
    assert_eq(data["error"], "REPLAY_DETECTED", "replay error code")


def test_hmac_with_previous_secret():
    """HMAC signed with previous secret should be accepted (rotation)."""
    body = '{"test": true}'
    headers = sign_request("POST", "/invoke", body, "trace-rotation", secret=SECRET_PREV)
    response = client.post("/invoke", content=body.encode("utf-8"), headers=headers)
    # Should NOT be 403 — HMAC with previous secret should pass
    assert response.status_code != 403, f"Previous secret should be accepted, got {response.status_code}"


def test_hmac_with_wrong_secret_returns_403():
    """HMAC signed with unknown secret should be rejected."""
    body = '{"test": true}'
    headers = sign_request("POST", "/invoke", body, "trace-wrong", secret="totally-wrong-secret!!!")
    response = client.post("/invoke", content=body.encode("utf-8"), headers=headers)
    assert_eq(response.status_code, 403, "wrong secret status")


def test_hmac_endpoint_binding():
    """HMAC signed for /invoke should NOT work for /invoke/stream."""
    body = '{"test": true}'
    # Sign for /invoke
    headers = sign_request("POST", "/invoke", body, "trace-bind")
    # Send to /invoke/stream — should fail HMAC because path differs
    response = client.post("/invoke/stream", content=body.encode("utf-8"), headers=headers)
    assert_eq(response.status_code, 403, "endpoint binding status")


# --- Streaming Endpoint Tests ---


def test_invoke_stream_invalid_json_returns_400():
    """POST /invoke/stream with invalid JSON should return 400."""
    body = "not json {"
    headers = sign_request("POST", "/invoke/stream", body, "trace-stream-bad")
    response = client.post("/invoke/stream", content=body.encode("utf-8"), headers=headers)
    assert_eq(response.status_code, 400, "stream invalid json status")
    data = response.json()
    assert_eq(data["error"], "INVALID_JSON", "stream invalid json error")


def test_invoke_stream_missing_provider_returns_400():
    """POST /invoke/stream with missing provider should return 400."""
    body = json.dumps({"model": "test", "messages": [], "metadata": {"trace_id": "t-s1"}})
    headers = sign_request("POST", "/invoke/stream", body, "t-s1")
    response = client.post("/invoke/stream", content=body.encode("utf-8"), headers=headers)
    assert_eq(response.status_code, 400, "stream missing provider status")
    data = response.json()
    assert_eq(data["error"], "MISSING_PROVIDER", "stream missing provider error")


def test_invoke_stream_hmac_required():
    """POST /invoke/stream without HMAC should be rejected."""
    response = client.post("/invoke/stream", content=b'{"test": true}')
    assert_eq(response.status_code, 403, "stream missing HMAC status")


# --- /invoke Endpoint Tests ---


def test_invoke_missing_provider_returns_400():
    """POST /invoke with missing provider config should return 400."""
    body = json.dumps({"model": "test", "messages": [], "metadata": {"trace_id": "t1"}})
    headers = sign_request("POST", "/invoke", body, "t1")
    response = client.post("/invoke", content=body.encode("utf-8"), headers=headers)
    assert_eq(response.status_code, 400, "missing provider status")
    data = response.json()
    assert_eq(data["error"], "MISSING_PROVIDER", "missing provider error")


def test_invoke_invalid_json_returns_400():
    """POST /invoke with invalid JSON should return 400."""
    body = "not json {"
    headers = sign_request("POST", "/invoke", body, "t-json")
    response = client.post("/invoke", content=body.encode("utf-8"), headers=headers)
    assert_eq(response.status_code, 400, "invalid json status")
    data = response.json()
    assert_eq(data["error"], "INVALID_JSON", "invalid json error")


# --- LRU Nonce Cache Unit Tests ---


def test_lru_nonce_cache_new_nonce_allowed():
    cache = LRUNonceCache(max_size=100)
    assert cache.check_and_add("nonce-1", 60.0) is True, "new nonce should be allowed"


def test_lru_nonce_cache_duplicate_rejected():
    cache = LRUNonceCache(max_size=100)
    cache.check_and_add("nonce-1", 60.0)
    assert cache.check_and_add("nonce-1", 60.0) is False, "duplicate nonce should be rejected"


def test_lru_nonce_cache_eviction_on_capacity():
    cache = LRUNonceCache(max_size=3)
    cache.check_and_add("a", 60.0)
    cache.check_and_add("b", 60.0)
    cache.check_and_add("c", 60.0)
    assert_eq(cache.size, 3, "cache at capacity")
    cache.check_and_add("d", 60.0)  # Should evict "a"
    assert_eq(cache.size, 3, "cache stays at capacity")
    # "a" was evicted — should be allowed again
    assert cache.check_and_add("a", 60.0) is True, "evicted nonce should be re-allowed"


def test_lru_nonce_cache_expired_eviction():
    cache = LRUNonceCache(max_size=100)
    # Add with 0 TTL (already expired)
    cache._cache["old-nonce"] = time.monotonic() - 1.0
    assert_eq(cache.size, 1, "has expired entry")
    # Next check_and_add triggers eviction
    cache.check_and_add("new-nonce", 60.0)
    assert_eq(cache.size, 1, "expired entry evicted")
    # Expired nonce should be re-allowed
    assert cache.check_and_add("old-nonce", 60.0) is True, "expired nonce re-allowed"


# --- HMAC Verification Unit Tests ---


def test_verify_hmac_phase3_valid():
    body = b'{"hello":"world"}'
    nonce = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"
    issued_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    assert verify_hmac_phase3(
        "POST", "/invoke", body, "",  # Will compute signature below
        nonce, "trace-1", issued_at, SECRET,
    ) is False  # Empty signature should fail


def test_verify_hmac_phase3_canonical_matches_typescript():
    """Canonical string format must match TypeScript hmac.ts buildCanonical()."""
    body = b'{"model":"gpt-4o","messages":[{"content":"hello","role":"user"}]}'
    canonical = build_canonical_phase3(
        "POST", "/invoke", body,
        "2026-02-08T12:00:00.000Z",
        "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
        "550e8400-e29b-41d4-a716-446655440000",
    )
    # Body hash must match
    body_hash = hashlib.sha256(body).hexdigest()
    expected = f"POST\n/invoke\n{body_hash}\n2026-02-08T12:00:00.000Z\na1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4\n550e8400-e29b-41d4-a716-446655440000"
    assert_eq(canonical, expected, "canonical string format")


# --- Main ---


def main():
    print("Cheval Sidecar Tests (T-1.2)")
    print("============================")

    # Clear nonce cache between test runs
    nonce_cache.clear()

    print()
    print("Health endpoints:")
    test("GET /healthz returns 200", test_healthz_returns_200)
    test("GET /readyz returns 200", test_readyz_returns_200)
    test("GET /healthz bypasses HMAC", test_healthz_bypasses_hmac)
    test("GET /readyz bypasses HMAC", test_readyz_bypasses_hmac)

    print()
    print("HMAC middleware:")
    nonce_cache.clear()
    test("POST without HMAC returns 403", test_post_without_hmac_returns_403)
    test("POST with partial HMAC returns 403", test_post_with_partial_hmac_returns_403)
    test("POST with invalid signature returns 403", test_post_with_invalid_signature_returns_403)
    test("POST with expired timestamp returns 403", test_post_with_expired_timestamp_returns_403)
    test("POST with valid HMAC passes middleware", test_post_with_valid_hmac_passes_middleware)
    test("POST with previous secret accepted (rotation)", test_hmac_with_previous_secret)
    test("POST with wrong secret returns 403", test_hmac_with_wrong_secret_returns_403)
    test("HMAC endpoint binding (path mismatch)", test_hmac_endpoint_binding)

    print()
    print("Nonce replay protection:")
    nonce_cache.clear()
    test("Nonce replay returns 403", test_nonce_replay_returns_403)

    print()
    print("Streaming endpoint:")
    nonce_cache.clear()
    test("POST /invoke/stream invalid JSON returns 400", test_invoke_stream_invalid_json_returns_400)
    nonce_cache.clear()
    test("POST /invoke/stream missing provider returns 400", test_invoke_stream_missing_provider_returns_400)
    test("POST /invoke/stream HMAC required", test_invoke_stream_hmac_required)

    print()
    print("/invoke endpoint:")
    nonce_cache.clear()
    test("Missing provider returns 400", test_invoke_missing_provider_returns_400)
    test("Invalid JSON returns 400", test_invoke_invalid_json_returns_400)

    print()
    print("LRU Nonce Cache unit tests:")
    test("New nonce allowed", test_lru_nonce_cache_new_nonce_allowed)
    test("Duplicate nonce rejected", test_lru_nonce_cache_duplicate_rejected)
    test("Eviction on capacity", test_lru_nonce_cache_eviction_on_capacity)
    test("Expired entry eviction", test_lru_nonce_cache_expired_eviction)

    print()
    print("HMAC verification unit tests:")
    test("Empty signature fails", test_verify_hmac_phase3_valid)
    test("Canonical string matches TypeScript format", test_verify_hmac_phase3_canonical_matches_typescript)

    print()
    print(f"Results: {passed} passed, {failed} failed")

    if failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
