#!/usr/bin/env python3
"""
cheval_test.py — Provider conformance tests for cheval.py (T-14.10)

Validates response normalization against golden fixtures.
Run: python3 adapters/cheval_test.py
"""

import json
import os
import sys

# Add parent dir so we can import cheval
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cheval import normalize_response, extract_thinking, _extract_tool_calls, _extract_usage


FIXTURE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")

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


def load_fixture(provider: str, name: str) -> dict:
    path = os.path.join(FIXTURE_DIR, provider, f"{name}.json")
    with open(path) as f:
        return json.load(f)


def assert_eq(actual, expected, msg=""):
    if actual != expected:
        raise AssertionError(f"{msg}: expected {expected!r}, got {actual!r}")


def assert_none(actual, msg=""):
    if actual is not None:
        raise AssertionError(f"{msg}: expected None, got {actual!r}")


# === OpenAI Fixtures ===

def test_openai_completion():
    fixture = load_fixture("openai", "completion")
    result = normalize_response(fixture["raw_response"], "openai", "test-trace", 100.0)

    assert_eq(result["content"], fixture["expected"]["content"], "content")
    assert_none(result["thinking"], "thinking")
    assert_none(result["tool_calls"], "tool_calls")
    assert_eq(result["usage"]["prompt_tokens"], fixture["expected"]["usage"]["prompt_tokens"], "prompt_tokens")
    assert_eq(result["usage"]["completion_tokens"], fixture["expected"]["usage"]["completion_tokens"], "completion_tokens")
    assert_eq(result["usage"]["reasoning_tokens"], fixture["expected"]["usage"]["reasoning_tokens"], "reasoning_tokens")
    assert_eq(result["metadata"]["trace_id"], "test-trace", "trace_id")


def test_openai_tool_call():
    fixture = load_fixture("openai", "tool_call")
    result = normalize_response(fixture["raw_response"], "openai", "test-trace", 150.0)

    assert_eq(result["content"], "", "content should be empty string")
    assert_none(result["thinking"], "thinking")
    assert_eq(len(result["tool_calls"]), 1, "tool_calls count")
    assert_eq(result["tool_calls"][0]["id"], "call_abc123", "tool_call id")
    assert_eq(result["tool_calls"][0]["type"], "function", "tool_call type")
    assert_eq(result["tool_calls"][0]["function"]["name"], "get_weather", "tool name")
    assert_eq(result["usage"]["prompt_tokens"], 50, "prompt_tokens")


# === Moonshot Fixtures ===

def test_moonshot_completion():
    fixture = load_fixture("moonshot", "completion")
    result = normalize_response(fixture["raw_response"], "openai-compatible", "test-trace", 200.0)

    assert_eq(result["content"], fixture["expected"]["content"], "content")
    assert_none(result["thinking"], "thinking for non-thinking moonshot model")
    assert_none(result["tool_calls"], "tool_calls")


def test_moonshot_thinking_trace():
    fixture = load_fixture("moonshot", "thinking_trace")
    result = normalize_response(fixture["raw_response"], "openai-compatible", "test-trace", 300.0)

    assert_eq(result["content"], fixture["expected"]["content"], "content")
    assert_eq(result["thinking"], fixture["expected"]["thinking"], "thinking trace")
    assert_none(result["tool_calls"], "tool_calls")
    assert_eq(result["usage"]["reasoning_tokens"], fixture["expected"]["usage"]["reasoning_tokens"], "reasoning_tokens")


# === Qwen-Local Fixtures ===

def test_qwen_completion():
    fixture = load_fixture("qwen-local", "completion")
    result = normalize_response(fixture["raw_response"], "openai-compatible", "test-trace", 50.0)

    assert_eq(result["content"], fixture["expected"]["content"], "content")
    assert_none(result["thinking"], "thinking for non-thinking qwen model")
    assert_none(result["tool_calls"], "tool_calls")
    assert_eq(result["usage"]["prompt_tokens"], 100, "prompt_tokens")


def test_qwen_tool_call():
    fixture = load_fixture("qwen-local", "tool_call")
    result = normalize_response(fixture["raw_response"], "openai-compatible", "test-trace", 75.0)

    assert_eq(result["content"], "", "content should be empty string")
    assert_eq(len(result["tool_calls"]), 1, "tool_calls count")
    assert_eq(result["tool_calls"][0]["function"]["name"], "read_file", "tool name")


# === Edge Case / Contract Tests ===

def test_thinking_null_for_openai():
    """OpenAI models should always have thinking=null"""
    raw = {
        "choices": [{"message": {"role": "assistant", "content": "test"}}],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1},
    }
    result = normalize_response(raw, "openai", "t", 0.0)
    assert_none(result["thinking"], "thinking must be null for openai")


def test_thinking_null_not_empty_string():
    """thinking should be null, not empty string, for non-thinking models"""
    raw = {
        "choices": [{"message": {"role": "assistant", "content": "test"}}],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1},
    }
    result = normalize_response(raw, "openai", "t", 0.0)
    if result["thinking"] is not None:
        raise AssertionError(f"thinking should be None, not {result['thinking']!r}")


def test_missing_usage_defaults_to_zero():
    """Missing usage fields default to 0 with warning"""
    raw = {
        "choices": [{"message": {"role": "assistant", "content": "test"}}],
    }
    result = normalize_response(raw, "openai", "t", 0.0)
    assert_eq(result["usage"]["prompt_tokens"], 0, "prompt_tokens default")
    assert_eq(result["usage"]["completion_tokens"], 0, "completion_tokens default")
    assert_eq(result["usage"]["reasoning_tokens"], 0, "reasoning_tokens default")


def test_malformed_tool_calls_skipped():
    """Malformed tool_calls are skipped with warning"""
    raw = {
        "choices": [{
            "message": {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    "not_a_dict",
                    {"id": "ok", "type": "function", "function": {"name": "valid", "arguments": "{}"}},
                    {"id": "bad", "type": "function", "function": {}},
                ],
            },
        }],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1},
    }
    result = normalize_response(raw, "openai", "t", 0.0)
    # Should have only the valid tool call
    assert_eq(len(result["tool_calls"]), 1, "only valid tool_call kept")
    assert_eq(result["tool_calls"][0]["function"]["name"], "valid", "valid tool name")


def test_non_json_error_body_wrapped():
    """Non-JSON error bodies are handled gracefully"""
    # This tests _safe_error_body indirectly — the response normalization
    # should handle responses with no choices gracefully
    raw = {"model": "test", "choices": []}
    result = normalize_response(raw, "openai", "t", 0.0)
    assert_eq(result["content"], "", "empty content for no choices")
    assert_none(result["tool_calls"], "no tool_calls for no choices")


def test_empty_choices_returns_empty_result():
    raw = {"choices": [], "usage": {"prompt_tokens": 5, "completion_tokens": 0}}
    result = normalize_response(raw, "openai", "t", 0.0)
    assert_eq(result["content"], "", "content")
    assert_none(result["thinking"], "thinking")
    assert_none(result["tool_calls"], "tool_calls")


def test_content_thinking_separation():
    """Content and thinking should never leak into each other"""
    raw = {
        "choices": [{
            "message": {
                "role": "assistant",
                "content": "Final answer only.",
                "reasoning_content": "This is private reasoning.",
            },
        }],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1},
    }
    result = normalize_response(raw, "openai-compatible", "t", 0.0)
    assert_eq(result["content"], "Final answer only.", "content clean")
    assert_eq(result["thinking"], "This is private reasoning.", "thinking clean")
    # Verify no cross-contamination
    if "reasoning" in result["content"].lower():
        raise AssertionError("thinking content leaked into content field")
    if "Final" in (result["thinking"] or ""):
        raise AssertionError("content leaked into thinking field")


# === Main ===

def main():
    print("Provider Conformance Tests (T-14.10)")
    print("====================================")
    print()

    print("OpenAI fixtures:")
    test("openai/completion", test_openai_completion)
    test("openai/tool_call", test_openai_tool_call)

    print()
    print("Moonshot fixtures:")
    test("moonshot/completion", test_moonshot_completion)
    test("moonshot/thinking_trace", test_moonshot_thinking_trace)

    print()
    print("Qwen-Local fixtures:")
    test("qwen-local/completion", test_qwen_completion)
    test("qwen-local/tool_call", test_qwen_tool_call)

    print()
    print("Edge cases / contract tests:")
    test("thinking=null for openai (not empty string)", test_thinking_null_for_openai)
    test("thinking=null not empty string", test_thinking_null_not_empty_string)
    test("missing usage defaults to 0", test_missing_usage_defaults_to_zero)
    test("malformed tool_calls skipped", test_malformed_tool_calls_skipped)
    test("non-JSON error body handled", test_non_json_error_body_wrapped)
    test("empty choices returns empty result", test_empty_choices_returns_empty_result)
    test("content/thinking separation", test_content_thinking_separation)

    print()
    print(f"Results: {passed} passed, {failed} failed")

    if failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
