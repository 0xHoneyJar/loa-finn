"""Tests for usage calculator, pricing, and cost ledger (Task 1.9).

Validates:
- Pricing calculations against golden vectors
- Cost ledger write/read with JSONL format
- Usage calculator enriches responses with cost data
- Cheval does NOT reject requests for budget reasons
"""

import json
import os
import sys
import tempfile

import pytest

# Ensure adapters/ is on path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pricing import (
    CostBreakdown,
    PricingEntry,
    RemainderAccumulator,
    calculate_cost_micro,
    calculate_total_cost,
    find_default_pricing,
)
from cost_ledger import (
    append_ledger,
    create_ledger_entry,
    read_daily_spend,
    read_ledger,
    record_cost,
    update_daily_spend,
)
from usage_calculator import (
    compute_cost_estimate,
    enrich_response_with_cost,
    record_usage,
)


# ── Golden vector cross-check ──────────────────────────────────────────

VECTORS_PATH = os.path.join(
    os.path.dirname(__file__),
    "..",
    "packages",
    "loa-hounfour",
    "vectors",
    "budget",
    "basic-pricing.json",
)


@pytest.mark.skipif(
    not os.path.exists(VECTORS_PATH),
    reason="Golden vectors not found",
)
class TestGoldenVectorCrossCheck:
    """Verify Python pricing matches TypeScript golden vectors."""

    def _load_vectors(self):
        with open(VECTORS_PATH) as f:
            return json.load(f)

    def test_single_cost_vectors(self):
        data = self._load_vectors()
        for v in data["single_cost_vectors"]:
            cost, rem = calculate_cost_micro(v["tokens"], v["price_micro_per_million"])
            assert cost == v["expected_cost_micro"], f"{v['id']}: cost mismatch"
            assert rem == v["expected_remainder_micro"], f"{v['id']}: remainder mismatch"

    def test_total_cost_vectors(self):
        data = self._load_vectors()
        for v in data["total_cost_vectors"]:
            inp = v["input"]
            pricing = PricingEntry(
                provider="test",
                model="test",
                input_per_mtok=inp["pricing"]["input_micro_per_million"],
                output_per_mtok=inp["pricing"]["output_micro_per_million"],
                reasoning_per_mtok=inp["pricing"].get("reasoning_micro_per_million", 0),
            )
            result = calculate_total_cost(
                inp["prompt_tokens"],
                inp["completion_tokens"],
                inp["reasoning_tokens"],
                pricing,
            )
            exp = v["expected"]
            assert result.input_cost_micro == exp["input_cost_micro"], f"{v['id']}: input mismatch"
            assert result.output_cost_micro == exp["output_cost_micro"], f"{v['id']}: output mismatch"
            assert result.reasoning_cost_micro == exp["reasoning_cost_micro"], f"{v['id']}: reasoning mismatch"
            assert result.total_cost_micro == exp["total_cost_micro"], f"{v['id']}: total mismatch"

    def test_remainder_accumulator_sequences(self):
        data = self._load_vectors()
        for seq in data["remainder_accumulator_sequences"]:
            acc = RemainderAccumulator()
            for step in seq["steps"]:
                _, rem = calculate_cost_micro(step["tokens"], step["price_micro_per_million"])
                carry = acc.carry(seq["scope_key"], rem)
                assert carry == step["expected_carry"], f"{seq['id']}: carry mismatch"
                assert acc.get(seq["scope_key"]) == step["expected_accumulated"], f"{seq['id']}: accumulated mismatch"


# ── Pricing unit tests ─────────────────────────────────────────────────


class TestCalculateCostMicro:
    def test_zero_tokens(self):
        cost, rem = calculate_cost_micro(0, 2_500_000)
        assert cost == 0
        assert rem == 0

    def test_exact_division(self):
        cost, rem = calculate_cost_micro(1000, 2_500_000)
        assert cost == 2500
        assert rem == 0

    def test_with_remainder(self):
        cost, rem = calculate_cost_micro(7, 2_500_000)
        assert cost == 17
        assert rem == 500_000

    def test_overflow_raises(self):
        with pytest.raises(ValueError, match="BUDGET_OVERFLOW"):
            calculate_cost_micro(100_000_000, 100_000_000)

    def test_zero_price(self):
        cost, rem = calculate_cost_micro(1000, 0)
        assert cost == 0
        assert rem == 0


class TestFindDefaultPricing:
    def test_known_model(self):
        entry = find_default_pricing("openai", "gpt-4o")
        assert entry is not None
        assert entry.input_per_mtok == 2_500_000
        assert entry.output_per_mtok == 10_000_000

    def test_unknown_model(self):
        entry = find_default_pricing("unknown", "unknown-model")
        assert entry is None


# ── Cost ledger tests ──────────────────────────────────────────────────


class TestCostLedger:
    def test_append_and_read(self, tmp_path):
        ledger_path = str(tmp_path / "test.jsonl")
        entry = {
            "trace_id": "tr-123",
            "cost_micro_usd": 2500,
            "model": "gpt-4o",
        }
        append_ledger(entry, ledger_path)
        entries = read_ledger(ledger_path)
        assert len(entries) == 1
        assert entries[0]["trace_id"] == "tr-123"

    def test_multiple_appends(self, tmp_path):
        ledger_path = str(tmp_path / "test.jsonl")
        for i in range(5):
            append_ledger({"id": i}, ledger_path)
        entries = read_ledger(ledger_path)
        assert len(entries) == 5

    def test_corruption_recovery(self, tmp_path):
        ledger_path = str(tmp_path / "corrupt.jsonl")
        with open(ledger_path, "w") as f:
            f.write('{"id": 1}\n')
            f.write("CORRUPTED LINE\n")
            f.write('{"id": 2}\n')
        entries = read_ledger(ledger_path)
        assert len(entries) == 2

    def test_read_nonexistent(self, tmp_path):
        entries = read_ledger(str(tmp_path / "nope.jsonl"))
        assert entries == []

    def test_daily_spend_counter(self, tmp_path):
        ledger_path = str(tmp_path / "ledger.jsonl")
        assert read_daily_spend(ledger_path) == 0
        update_daily_spend(1000, ledger_path)
        assert read_daily_spend(ledger_path) == 1000
        update_daily_spend(500, ledger_path)
        assert read_daily_spend(ledger_path) == 1500

    def test_create_ledger_entry_with_default_pricing(self):
        entry = create_ledger_entry(
            trace_id="tr-test",
            agent="test",
            provider="openai",
            model="gpt-4o",
            input_tokens=1000,
            output_tokens=500,
            reasoning_tokens=0,
            latency_ms=200,
            config={},
        )
        assert entry["trace_id"] == "tr-test"
        assert entry["cost_micro_usd"] == 7500  # 2500 input + 5000 output
        assert entry["pricing_source"] == "default"

    def test_create_ledger_entry_unknown_model(self):
        entry = create_ledger_entry(
            trace_id="tr-unknown",
            agent="test",
            provider="unknown",
            model="unknown",
            input_tokens=1000,
            output_tokens=500,
            reasoning_tokens=0,
            latency_ms=100,
            config={},
        )
        assert entry["cost_micro_usd"] == 0
        assert entry["pricing_source"] == "unknown"


# ── Usage calculator tests ─────────────────────────────────────────────


class TestComputeCostEstimate:
    def test_known_model(self):
        usage = {"prompt_tokens": 1000, "completion_tokens": 500, "reasoning_tokens": 0}
        cost = compute_cost_estimate(usage, "openai", "gpt-4o")
        assert cost is not None
        assert cost["input_cost_micro"] == "2500"
        assert cost["output_cost_micro"] == "5000"
        assert cost["total_cost_micro"] == "7500"

    def test_unknown_model_returns_none(self):
        usage = {"prompt_tokens": 100, "completion_tokens": 50, "reasoning_tokens": 0}
        cost = compute_cost_estimate(usage, "unknown", "unknown")
        assert cost is None

    def test_with_reasoning(self):
        usage = {"prompt_tokens": 4096, "completion_tokens": 2048, "reasoning_tokens": 1024}
        cost = compute_cost_estimate(usage, "anthropic", "claude-opus-4-6")
        assert cost is not None
        assert cost["input_cost_micro"] == "61440"
        assert cost["output_cost_micro"] == "153600"
        assert cost["reasoning_cost_micro"] == "76800"
        assert cost["total_cost_micro"] == "291840"


class TestEnrichResponseWithCost:
    def test_enriches_usage(self):
        result = {
            "content": "Hello",
            "usage": {"prompt_tokens": 1000, "completion_tokens": 500, "reasoning_tokens": 0},
        }
        enriched = enrich_response_with_cost(result, "openai", "gpt-4o")
        assert "cost" in enriched["usage"]
        assert enriched["usage"]["cost"]["total_cost_micro"] == "7500"
        # Original dict unchanged
        assert "cost" not in result["usage"]

    def test_no_usage(self):
        result = {"content": "Hello"}
        enriched = enrich_response_with_cost(result, "openai", "gpt-4o")
        assert enriched == result

    def test_unknown_model_no_cost(self):
        result = {
            "content": "Hello",
            "usage": {"prompt_tokens": 100, "completion_tokens": 50, "reasoning_tokens": 0},
        }
        enriched = enrich_response_with_cost(result, "unknown", "unknown")
        assert "cost" not in enriched["usage"]


class TestRecordUsage:
    def test_records_to_ledger(self, tmp_path):
        ledger_path = str(tmp_path / "test.jsonl")
        record_usage(
            trace_id="tr-record",
            provider="openai",
            model="gpt-4o",
            usage={"prompt_tokens": 1000, "completion_tokens": 500, "reasoning_tokens": 0},
            latency_ms=200.0,
            ledger_path=ledger_path,
        )
        entries = read_ledger(ledger_path)
        assert len(entries) == 1
        assert entries[0]["trace_id"] == "tr-record"
        assert entries[0]["cost_micro_usd"] == 7500

    def test_no_exception_on_bad_path(self):
        """Usage calculator must never crash the caller."""
        # /dev/null/impossible is not writable, but record_usage should not raise
        record_usage(
            trace_id="tr-fail",
            provider="openai",
            model="gpt-4o",
            usage={"prompt_tokens": 100, "completion_tokens": 50, "reasoning_tokens": 0},
            latency_ms=100.0,
            ledger_path="/dev/null/impossible/path.jsonl",
        )


class TestNoBudgetEnforcement:
    """Verify cheval does NOT reject requests for budget reasons (Task 1.9 AC)."""

    def test_no_budget_deny_in_usage_calculator(self):
        """usage_calculator module has no BLOCK/DOWNGRADE/enforcement logic."""
        import usage_calculator

        # These functions should not exist in usage_calculator
        assert not hasattr(usage_calculator, "pre_call")
        assert not hasattr(usage_calculator, "check_budget")
        assert not hasattr(usage_calculator, "BudgetEnforcer")
        assert not hasattr(usage_calculator, "BLOCK")
        assert not hasattr(usage_calculator, "DOWNGRADE")
