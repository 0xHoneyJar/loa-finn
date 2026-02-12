"""Tests for circuit breaker state machine (Task 1.10).

Validates:
- State transitions: CLOSED → OPEN → HALF_OPEN → CLOSED
- Failure counting with sliding window
- Reset timeout triggers HALF_OPEN
- Probe success/failure in HALF_OPEN
- File persistence and cleanup
"""

import json
import os
import sys
import time

import pytest

# Ensure adapters/ is on path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from circuit_breaker import (
    CLOSED,
    HALF_OPEN,
    OPEN,
    check_state,
    cleanup_stale_files,
    increment_probe,
    record_failure,
    record_success,
)


def _config(threshold=3, reset_timeout=60, count_window=300, max_probes=1):
    """Build a config dict with circuit breaker settings."""
    return {
        "routing": {
            "circuit_breaker": {
                "failure_threshold": threshold,
                "reset_timeout_seconds": reset_timeout,
                "count_window_seconds": count_window,
                "half_open_max_probes": max_probes,
            }
        }
    }


# ── State transitions ─────────────────────────────────────────────────


class TestClosedState:
    def test_initial_state_is_closed(self, tmp_path):
        state = check_state("test-provider", _config(), str(tmp_path))
        assert state == CLOSED

    def test_single_failure_stays_closed(self, tmp_path):
        result = record_failure("test-provider", _config(threshold=3), str(tmp_path))
        assert result == CLOSED

    def test_failures_below_threshold_stay_closed(self, tmp_path):
        cfg = _config(threshold=5)
        run_dir = str(tmp_path)
        for _ in range(4):
            result = record_failure("test-provider", cfg, run_dir)
        assert result == CLOSED

    def test_success_resets_failure_count(self, tmp_path):
        cfg = _config(threshold=3)
        run_dir = str(tmp_path)
        record_failure("test-provider", cfg, run_dir)
        record_failure("test-provider", cfg, run_dir)
        record_success("test-provider", cfg, run_dir)
        # After success reset, need 3 more failures to trip
        record_failure("test-provider", cfg, run_dir)
        record_failure("test-provider", cfg, run_dir)
        assert check_state("test-provider", cfg, run_dir) == CLOSED


class TestClosedToOpen:
    def test_threshold_failures_opens_circuit(self, tmp_path):
        cfg = _config(threshold=3)
        run_dir = str(tmp_path)
        record_failure("test-provider", cfg, run_dir)
        record_failure("test-provider", cfg, run_dir)
        result = record_failure("test-provider", cfg, run_dir)
        assert result == OPEN

    def test_check_state_returns_open(self, tmp_path):
        cfg = _config(threshold=3)
        run_dir = str(tmp_path)
        for _ in range(3):
            record_failure("test-provider", cfg, run_dir)
        assert check_state("test-provider", cfg, run_dir) == OPEN

    def test_failure_count_resets_outside_window(self, tmp_path):
        """Failures outside count_window don't accumulate."""
        cfg = _config(threshold=3, count_window=1)
        run_dir = str(tmp_path)
        record_failure("test-provider", cfg, run_dir)
        record_failure("test-provider", cfg, run_dir)

        # Manually backdate last_failure_ts to simulate window expiry
        path = os.path.join(run_dir, "circuit-breaker-test-provider.json")
        with open(path) as f:
            state = json.load(f)
        state["last_failure_ts"] = time.time() - 10  # 10s ago, window is 1s
        with open(path, "w") as f:
            json.dump(state, f)

        # This failure should reset count to 1 (outside window)
        result = record_failure("test-provider", cfg, run_dir)
        assert result == CLOSED  # 1 failure, threshold is 3


class TestOpenToHalfOpen:
    def test_open_transitions_to_half_open_after_timeout(self, tmp_path):
        cfg = _config(threshold=1, reset_timeout=1)
        run_dir = str(tmp_path)
        record_failure("test-provider", cfg, run_dir)

        # Backdate opened_at to simulate timeout expiry
        path = os.path.join(run_dir, "circuit-breaker-test-provider.json")
        with open(path) as f:
            state = json.load(f)
        state["opened_at"] = time.time() - 10
        with open(path, "w") as f:
            json.dump(state, f)

        result = check_state("test-provider", cfg, run_dir)
        assert result == HALF_OPEN

    def test_open_stays_open_before_timeout(self, tmp_path):
        cfg = _config(threshold=1, reset_timeout=3600)
        run_dir = str(tmp_path)
        record_failure("test-provider", cfg, run_dir)
        result = check_state("test-provider", cfg, run_dir)
        assert result == OPEN


class TestHalfOpenState:
    def _make_half_open(self, run_dir, cfg):
        """Helper: open then transition to half-open."""
        record_failure("test-provider", cfg, run_dir)
        path = os.path.join(run_dir, "circuit-breaker-test-provider.json")
        with open(path) as f:
            state = json.load(f)
        state["opened_at"] = time.time() - 1000
        with open(path, "w") as f:
            json.dump(state, f)
        check_state("test-provider", cfg, run_dir)

    def test_probe_success_closes_circuit(self, tmp_path):
        cfg = _config(threshold=1, reset_timeout=1)
        run_dir = str(tmp_path)
        self._make_half_open(run_dir, cfg)
        result = record_success("test-provider", cfg, run_dir)
        assert result == CLOSED

    def test_probe_failure_reopens_circuit(self, tmp_path):
        cfg = _config(threshold=1, reset_timeout=1)
        run_dir = str(tmp_path)
        self._make_half_open(run_dir, cfg)
        result = record_failure("test-provider", cfg, run_dir)
        assert result == OPEN

    def test_max_probes_returns_open(self, tmp_path):
        cfg = _config(threshold=1, reset_timeout=1, max_probes=1)
        run_dir = str(tmp_path)
        self._make_half_open(run_dir, cfg)
        increment_probe("test-provider", run_dir)
        result = check_state("test-provider", cfg, run_dir)
        assert result == OPEN

    def test_probe_within_limit_returns_half_open(self, tmp_path):
        cfg = _config(threshold=1, reset_timeout=1, max_probes=2)
        run_dir = str(tmp_path)
        self._make_half_open(run_dir, cfg)
        increment_probe("test-provider", run_dir)
        result = check_state("test-provider", cfg, run_dir)
        assert result == HALF_OPEN


class TestIncrementProbe:
    def test_increments_counter(self, tmp_path):
        cfg = _config(threshold=1, reset_timeout=1)
        run_dir = str(tmp_path)
        # Open then half-open
        record_failure("test-provider", cfg, run_dir)
        path = os.path.join(run_dir, "circuit-breaker-test-provider.json")
        with open(path) as f:
            state = json.load(f)
        state["opened_at"] = time.time() - 1000
        state["state"] = "HALF_OPEN"
        state["half_open_probes"] = 0
        with open(path, "w") as f:
            json.dump(state, f)

        increment_probe("test-provider", run_dir)

        with open(path) as f:
            state = json.load(f)
        assert state["half_open_probes"] == 1

    def test_noop_when_not_half_open(self, tmp_path):
        """increment_probe does nothing when circuit is CLOSED."""
        run_dir = str(tmp_path)
        increment_probe("test-provider", run_dir)
        # No file created means no state written
        path = os.path.join(run_dir, "circuit-breaker-test-provider.json")
        assert not os.path.exists(path)


# ── File persistence ──────────────────────────────────────────────────


class TestPersistence:
    def test_state_persists_to_file(self, tmp_path):
        cfg = _config(threshold=3)
        run_dir = str(tmp_path)
        record_failure("test-provider", cfg, run_dir)
        path = os.path.join(run_dir, "circuit-breaker-test-provider.json")
        assert os.path.exists(path)
        with open(path) as f:
            data = json.load(f)
        assert data["provider"] == "test-provider"
        assert data["state"] == CLOSED
        assert data["failure_count"] == 1

    def test_corrupted_file_returns_default(self, tmp_path):
        run_dir = str(tmp_path)
        path = os.path.join(run_dir, "circuit-breaker-bad.json")
        os.makedirs(run_dir, exist_ok=True)
        with open(path, "w") as f:
            f.write("NOT JSON")
        state = check_state("bad", _config(), run_dir)
        assert state == CLOSED

    def test_multi_provider_isolation(self, tmp_path):
        cfg = _config(threshold=2)
        run_dir = str(tmp_path)
        record_failure("provider-a", cfg, run_dir)
        record_failure("provider-a", cfg, run_dir)
        record_failure("provider-b", cfg, run_dir)
        assert check_state("provider-a", cfg, run_dir) == OPEN
        assert check_state("provider-b", cfg, run_dir) == CLOSED


# ── Cleanup ───────────────────────────────────────────────────────────


class TestCleanup:
    def test_removes_stale_files(self, tmp_path):
        run_dir = str(tmp_path)
        path = os.path.join(run_dir, "circuit-breaker-old.json")
        os.makedirs(run_dir, exist_ok=True)
        with open(path, "w") as f:
            json.dump({"state": CLOSED}, f)
        # Backdate the file by 48 hours
        old_time = time.time() - 48 * 3600
        os.utime(path, (old_time, old_time))
        removed = cleanup_stale_files(run_dir, max_age_hours=24)
        assert removed == 1
        assert not os.path.exists(path)

    def test_preserves_recent_files(self, tmp_path):
        run_dir = str(tmp_path)
        path = os.path.join(run_dir, "circuit-breaker-recent.json")
        os.makedirs(run_dir, exist_ok=True)
        with open(path, "w") as f:
            json.dump({"state": CLOSED}, f)
        removed = cleanup_stale_files(run_dir, max_age_hours=24)
        assert removed == 0
        assert os.path.exists(path)

    def test_ignores_non_circuit_breaker_files(self, tmp_path):
        run_dir = str(tmp_path)
        path = os.path.join(run_dir, "other-file.json")
        os.makedirs(run_dir, exist_ok=True)
        with open(path, "w") as f:
            json.dump({}, f)
        old_time = time.time() - 48 * 3600
        os.utime(path, (old_time, old_time))
        removed = cleanup_stale_files(run_dir, max_age_hours=24)
        assert removed == 0

    def test_missing_dir_returns_zero(self):
        removed = cleanup_stale_files("/nonexistent/path", max_age_hours=24)
        assert removed == 0


# ── Full cycle ────────────────────────────────────────────────────────


class TestFullCycle:
    def test_closed_open_half_open_closed(self, tmp_path):
        """Test complete circuit breaker lifecycle."""
        cfg = _config(threshold=2, reset_timeout=1)
        run_dir = str(tmp_path)

        # Start CLOSED
        assert check_state("p", cfg, run_dir) == CLOSED

        # Accumulate failures → OPEN
        record_failure("p", cfg, run_dir)
        assert record_failure("p", cfg, run_dir) == OPEN
        assert check_state("p", cfg, run_dir) == OPEN

        # Backdate to trigger timeout → HALF_OPEN
        path = os.path.join(run_dir, "circuit-breaker-p.json")
        with open(path) as f:
            state = json.load(f)
        state["opened_at"] = time.time() - 100
        with open(path, "w") as f:
            json.dump(state, f)
        assert check_state("p", cfg, run_dir) == HALF_OPEN

        # Probe success → CLOSED
        assert record_success("p", cfg, run_dir) == CLOSED
        assert check_state("p", cfg, run_dir) == CLOSED
