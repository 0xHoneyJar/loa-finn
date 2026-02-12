"""Usage calculator — compute and record cost estimates for cheval responses.

Cherry-picked from loa_cheval/metering/budget.py, adapted to be a
USAGE CALCULATOR ONLY (SDD §4.5, Task 1.9).

IMPORTANT: This module does NOT enforce budget limits. Budget enforcement
is loa-finn's responsibility (via BudgetEnforcer in src/hounfour/budget.ts).
Cheval never rejects requests for budget reasons.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, Optional

from cost_ledger import create_ledger_entry, record_cost
from pricing import (
    CostBreakdown,
    PricingEntry,
    calculate_total_cost,
    find_default_pricing,
    find_pricing,
)

logger = logging.getLogger("cheval.usage_calculator")

# Env var for ledger path (default: data/hounfour/cost-ledger.jsonl)
DEFAULT_LEDGER_PATH = os.environ.get(
    "CHEVAL_LEDGER_PATH", "data/hounfour/cost-ledger.jsonl"
)


def compute_cost_estimate(
    usage: Dict[str, int],
    provider: str,
    model: str,
    config: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """Compute cost estimate from usage and pricing.

    Returns dict with cost breakdown in string micro-USD (wire format),
    or None if no pricing found.
    """
    pricing = None
    if config:
        pricing = find_pricing(provider, model, config)
    if not pricing:
        pricing = find_default_pricing(provider, model)
    if not pricing:
        return None

    breakdown = calculate_total_cost(
        input_tokens=usage.get("prompt_tokens", 0),
        output_tokens=usage.get("completion_tokens", 0),
        reasoning_tokens=usage.get("reasoning_tokens", 0),
        pricing=pricing,
    )

    return {
        "input_cost_micro": str(breakdown.input_cost_micro),
        "output_cost_micro": str(breakdown.output_cost_micro),
        "reasoning_cost_micro": str(breakdown.reasoning_cost_micro),
        "total_cost_micro": str(breakdown.total_cost_micro),
    }


def enrich_response_with_cost(
    result: Dict[str, Any],
    provider: str,
    model: str,
    config: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Add cost estimates to a normalized cheval response.

    Enriches result["usage"] with cost fields. Does not modify
    the original dict — returns a new copy.
    """
    enriched = dict(result)
    usage = result.get("usage", {})
    if not usage:
        return enriched

    cost = compute_cost_estimate(usage, provider, model, config)
    if cost:
        enriched_usage = dict(usage)
        enriched_usage["cost"] = cost
        enriched["usage"] = enriched_usage

    return enriched


def record_usage(
    trace_id: str,
    provider: str,
    model: str,
    usage: Dict[str, int],
    latency_ms: float,
    config: Optional[Dict[str, Any]] = None,
    ledger_path: Optional[str] = None,
) -> None:
    """Record usage to the cost ledger (fire-and-forget).

    This is a best-effort operation — ledger write failures are logged
    but do not propagate exceptions to the caller.
    """
    path = ledger_path or DEFAULT_LEDGER_PATH

    try:
        entry = create_ledger_entry(
            trace_id=trace_id,
            agent="cheval-sidecar",
            provider=provider,
            model=model,
            input_tokens=usage.get("prompt_tokens", 0),
            output_tokens=usage.get("completion_tokens", 0),
            reasoning_tokens=usage.get("reasoning_tokens", 0),
            latency_ms=int(latency_ms),
            config=config or {},
            usage_source="actual",
        )
        record_cost(entry, path)
    except Exception:
        logger.warning(
            "Failed to record usage for trace %s", trace_id, exc_info=True
        )
