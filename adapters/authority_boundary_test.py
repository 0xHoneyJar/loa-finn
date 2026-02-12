"""Cheval budget authority boundary verification (Task 1.13).

CRITICAL INVARIANT: The cheval sidecar NEVER enforces budget limits.
Budget enforcement is loa-finn's responsibility (BudgetEnforcer in
src/hounfour/budget.ts). Cheval computes costs and records usage,
but never rejects, blocks, or downgrades requests for budget reasons.

This test suite scans all imported cheval modules for any budget
enforcement code patterns and verifies the wire contract.
"""

import ast
import importlib
import inspect
import os
import sys

import pytest

# Ensure adapters/ is on path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# All cheval modules that were imported/adapted (Tasks 1.9-1.12)
CHEVAL_MODULES = [
    "pricing",
    "cost_ledger",
    "usage_calculator",
    "circuit_breaker",
    "provider_registry",
    "config_loader",
]

# Budget enforcement patterns that MUST NOT exist in cheval modules
FORBIDDEN_NAMES = [
    "BudgetEnforcer",
    "check_budget",
    "enforce_budget",
    "budget_check",
    "budget_enforce",
    "pre_call",  # budget pre-call hook
    "BLOCK",
    "DOWNGRADE",
    "REJECT",
    "DENY",
    "budget_exceeded",
    "BudgetExceededError",
    "over_budget",
]

FORBIDDEN_PATTERNS = [
    "reject",
    "block",
    "deny",
    "downgrade",
    "enforce",
    "exceeded",
]


class TestNoBudgetEnforcementInModules:
    """Verify no cheval module contains budget enforcement logic."""

    @pytest.mark.parametrize("module_name", CHEVAL_MODULES)
    def test_no_forbidden_attributes(self, module_name):
        """Module must not export budget enforcement attributes."""
        mod = importlib.import_module(module_name)
        for name in FORBIDDEN_NAMES:
            assert not hasattr(mod, name), (
                f"Module '{module_name}' has forbidden attribute '{name}'. "
                f"Budget enforcement belongs in loa-finn, not cheval."
            )

    @pytest.mark.parametrize("module_name", CHEVAL_MODULES)
    def test_no_budget_classes(self, module_name):
        """Module must not define budget enforcement classes."""
        mod = importlib.import_module(module_name)
        for name, obj in inspect.getmembers(mod, inspect.isclass):
            lower = name.lower()
            assert "budget" not in lower or "breakdown" in lower, (
                f"Module '{module_name}' has budget-related class '{name}'. "
                f"Only cost breakdown classes are allowed."
            )
            assert "enforc" not in lower, (
                f"Module '{module_name}' has enforcement class '{name}'."
            )

    @pytest.mark.parametrize("module_name", CHEVAL_MODULES)
    def test_no_budget_functions(self, module_name):
        """Module must not define budget enforcement functions."""
        mod = importlib.import_module(module_name)
        for name, obj in inspect.getmembers(mod, inspect.isfunction):
            lower = name.lower()
            for pattern in FORBIDDEN_PATTERNS:
                # Allow "redact" (not "reject"), "record" (not "reject")
                if pattern == "reject":
                    assert pattern not in lower, (
                        f"Module '{module_name}' has enforcement function '{name}'."
                    )
                elif pattern in lower and "budget" in lower:
                    pytest.fail(
                        f"Module '{module_name}' has budget enforcement function '{name}'."
                    )


class TestUsageCalculatorIsObservationOnly:
    """Verify usage_calculator computes costs but never enforces."""

    def test_no_pre_call_hook(self):
        import usage_calculator
        assert not hasattr(usage_calculator, "pre_call")

    def test_no_budget_check(self):
        import usage_calculator
        assert not hasattr(usage_calculator, "check_budget")

    def test_no_enforcement_classes(self):
        import usage_calculator
        assert not hasattr(usage_calculator, "BudgetEnforcer")

    def test_no_enforcement_constants(self):
        import usage_calculator
        assert not hasattr(usage_calculator, "BLOCK")
        assert not hasattr(usage_calculator, "DOWNGRADE")
        assert not hasattr(usage_calculator, "DENY")

    def test_compute_cost_never_raises_budget_error(self):
        """compute_cost_estimate returns None for unknown, never raises budget error."""
        from usage_calculator import compute_cost_estimate

        # Even with huge token counts, should compute (or return None), never reject
        result = compute_cost_estimate(
            {"prompt_tokens": 999_999, "completion_tokens": 999_999, "reasoning_tokens": 999_999},
            "openai",
            "gpt-4o",
        )
        assert result is not None
        assert "total_cost_micro" in result
        # Should NOT raise any budget-related error

    def test_record_usage_never_raises(self):
        """record_usage is fire-and-forget, never rejects."""
        from usage_calculator import record_usage

        # Should not raise even with absurd values
        record_usage(
            trace_id="boundary-test",
            provider="openai",
            model="gpt-4o",
            usage={"prompt_tokens": 999_999, "completion_tokens": 999_999, "reasoning_tokens": 0},
            latency_ms=1.0,
            ledger_path="/dev/null/impossible",
        )

    def test_enrich_response_always_returns(self):
        """enrich_response_with_cost always returns enriched result, never rejects."""
        from usage_calculator import enrich_response_with_cost

        result = {
            "content": "test",
            "usage": {
                "prompt_tokens": 999_999,
                "completion_tokens": 999_999,
                "reasoning_tokens": 0,
            },
        }
        enriched = enrich_response_with_cost(result, "openai", "gpt-4o")
        assert "content" in enriched
        assert "usage" in enriched


class TestCircuitBreakerIsNotBudgetRelated:
    """Verify circuit breaker operates on provider failures, not budget."""

    def test_no_budget_attributes(self):
        import circuit_breaker
        assert not hasattr(circuit_breaker, "budget")
        assert not hasattr(circuit_breaker, "cost")
        assert not hasattr(circuit_breaker, "spend")

    def test_circuit_breaker_based_on_failures_not_cost(self, tmp_path):
        """Circuit breaker trips on failure count, not cost."""
        from circuit_breaker import CLOSED, OPEN, record_failure

        config = {
            "routing": {
                "circuit_breaker": {
                    "failure_threshold": 2,
                }
            }
        }
        run_dir = str(tmp_path)
        record_failure("test", config, run_dir)
        result = record_failure("test", config, run_dir)
        assert result == OPEN  # Tripped by failure count, not cost


class TestCostLedgerIsAppendOnly:
    """Verify cost ledger only appends records, never blocks."""

    def test_no_enforcement_attributes(self):
        import cost_ledger
        assert not hasattr(cost_ledger, "check_budget")
        assert not hasattr(cost_ledger, "enforce_limit")
        assert not hasattr(cost_ledger, "BudgetEnforcer")

    def test_append_never_rejects(self, tmp_path):
        """append_ledger accepts any entry, never rejects for cost reasons."""
        from cost_ledger import append_ledger, read_ledger

        ledger_path = str(tmp_path / "test.jsonl")
        # Huge cost entry should still be accepted
        entry = {"cost_micro_usd": 999_999_999, "trace_id": "boundary"}
        append_ledger(entry, ledger_path)
        entries = read_ledger(ledger_path)
        assert len(entries) == 1
        assert entries[0]["cost_micro_usd"] == 999_999_999


class TestPricingIsComputeOnly:
    """Verify pricing module only computes costs, never enforces limits."""

    def test_no_enforcement_attributes(self):
        import pricing
        assert not hasattr(pricing, "check_limit")
        assert not hasattr(pricing, "enforce_budget")
        assert not hasattr(pricing, "BudgetEnforcer")

    def test_calculate_cost_returns_value_never_blocks(self):
        """calculate_total_cost always returns a cost breakdown."""
        from pricing import PricingEntry, calculate_total_cost

        pricing = PricingEntry(
            provider="test",
            model="test",
            input_per_mtok=2_500_000,
            output_per_mtok=10_000_000,
            reasoning_per_mtok=0,
        )
        # Large token count → large cost, but should never reject
        result = calculate_total_cost(100_000, 100_000, 0, pricing)
        assert result.total_cost_micro > 0


class TestWireContractObservationOnly:
    """Verify the cost wire format is observation-only metadata."""

    def test_cost_field_is_informational(self):
        """Cost data in usage is informational, not a gate."""
        from usage_calculator import enrich_response_with_cost

        result = {
            "content": "response text",
            "usage": {
                "prompt_tokens": 5000,
                "completion_tokens": 2000,
                "reasoning_tokens": 0,
            },
        }
        enriched = enrich_response_with_cost(result, "openai", "gpt-4o")
        cost = enriched["usage"]["cost"]

        # Cost fields are strings (wire format), not enforcement gates
        assert isinstance(cost["total_cost_micro"], str)
        assert isinstance(cost["input_cost_micro"], str)
        assert isinstance(cost["output_cost_micro"], str)

        # The response content is always preserved
        assert enriched["content"] == "response text"

    def test_unknown_model_still_returns_response(self):
        """Even with unknown pricing, the response is returned unchanged."""
        from usage_calculator import enrich_response_with_cost

        result = {
            "content": "response text",
            "usage": {"prompt_tokens": 100, "completion_tokens": 50, "reasoning_tokens": 0},
        }
        enriched = enrich_response_with_cost(result, "unknown", "unknown")
        # No cost data, but response is still returned
        assert enriched["content"] == "response text"
        assert "cost" not in enriched["usage"]


class TestSourceCodeAST:
    """Static analysis: scan module source for budget enforcement patterns."""

    @pytest.mark.parametrize("module_name", CHEVAL_MODULES)
    def test_no_raise_budget_error(self, module_name):
        """Module source must not raise budget-related exceptions."""
        mod = importlib.import_module(module_name)
        source_file = inspect.getfile(mod)
        with open(source_file) as f:
            source = f.read()

        tree = ast.parse(source)
        for node in ast.walk(tree):
            if isinstance(node, ast.Raise):
                # Check if raising budget-related exceptions
                if node.exc and isinstance(node.exc, ast.Call):
                    if isinstance(node.exc.func, ast.Name):
                        func_name = node.exc.func.id.lower()
                        assert "budget" not in func_name, (
                            f"Module '{module_name}' raises budget exception "
                            f"'{node.exc.func.id}' at line {node.lineno}. "
                            f"Budget enforcement belongs in loa-finn."
                        )
