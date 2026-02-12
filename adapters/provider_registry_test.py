"""Tests for provider registry and validation (Task 1.11).

Validates:
- Supported provider type registry
- Provider config validation
- Auth header resolution per provider type
- Token estimation
"""

import os
import sys

import pytest

# Ensure adapters/ is on path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from provider_registry import (
    ProviderDefaults,
    estimate_message_tokens,
    estimate_tokens,
    get_defaults,
    get_supported_types,
    is_supported_type,
    resolve_auth_headers,
    resolve_chat_url,
    validate_provider,
)


# ── Registry ──────────────────────────────────────────────────────────


class TestSupportedTypes:
    def test_openai_supported(self):
        assert is_supported_type("openai")

    def test_openai_compat_supported(self):
        assert is_supported_type("openai_compat")

    def test_anthropic_supported(self):
        assert is_supported_type("anthropic")

    def test_unknown_not_supported(self):
        assert not is_supported_type("unknown")

    def test_get_supported_types_returns_list(self):
        types = get_supported_types()
        assert isinstance(types, list)
        assert "openai" in types
        assert "anthropic" in types


class TestGetDefaults:
    def test_openai_defaults(self):
        defaults = get_defaults("openai")
        assert defaults is not None
        assert defaults.chat_path == "/chat/completions"
        assert defaults.auth_header == "Authorization"
        assert defaults.auth_prefix == "Bearer"

    def test_anthropic_defaults(self):
        defaults = get_defaults("anthropic")
        assert defaults is not None
        assert defaults.chat_path == "/messages"
        assert defaults.auth_header == "x-api-key"
        assert defaults.auth_prefix == ""
        assert "anthropic-version" in defaults.extra_headers

    def test_unknown_returns_none(self):
        assert get_defaults("unknown") is None


# ── Validation ────────────────────────────────────────────────────────


class TestValidation:
    def test_valid_provider(self):
        errors = validate_provider({
            "name": "openai-prod",
            "base_url": "https://api.openai.com/v1",
            "api_key": "sk-test",
            "type": "openai",
        })
        assert errors == []

    def test_missing_name(self):
        errors = validate_provider({
            "base_url": "https://api.openai.com/v1",
            "api_key": "sk-test",
        })
        assert any("name" in e for e in errors)

    def test_missing_base_url(self):
        errors = validate_provider({
            "name": "test",
            "api_key": "sk-test",
        })
        assert any("base_url" in e for e in errors)

    def test_missing_api_key(self):
        errors = validate_provider({
            "name": "test",
            "base_url": "https://api.openai.com/v1",
        })
        assert any("api_key" in e for e in errors)

    def test_unknown_type(self):
        errors = validate_provider({
            "name": "test",
            "base_url": "https://example.com",
            "api_key": "key",
            "type": "google",
        })
        assert any("Unknown provider type" in e for e in errors)

    def test_default_type_is_openai(self):
        """If type is missing, defaults to openai (no error)."""
        errors = validate_provider({
            "name": "test",
            "base_url": "https://api.openai.com/v1",
            "api_key": "sk-test",
        })
        assert errors == []

    def test_multiple_errors(self):
        errors = validate_provider({})
        assert len(errors) >= 3  # name, base_url, api_key


# ── Auth headers ──────────────────────────────────────────────────────


class TestAuthHeaders:
    def test_openai_bearer_auth(self):
        headers = resolve_auth_headers({
            "type": "openai",
            "api_key": "sk-test123",
        })
        assert headers["Authorization"] == "Bearer sk-test123"
        assert headers["Content-Type"] == "application/json"

    def test_anthropic_api_key_auth(self):
        headers = resolve_auth_headers({
            "type": "anthropic",
            "api_key": "sk-ant-test",
        })
        assert headers["x-api-key"] == "sk-ant-test"
        assert "Authorization" not in headers
        assert headers["anthropic-version"] == "2023-06-01"

    def test_default_type_uses_bearer(self):
        headers = resolve_auth_headers({"api_key": "key"})
        assert "Authorization" in headers


# ── Chat URL ──────────────────────────────────────────────────────────


class TestChatUrl:
    def test_openai_chat_path(self):
        path = resolve_chat_url({"type": "openai", "base_url": "https://api.openai.com/v1"})
        assert path == "/chat/completions"

    def test_anthropic_chat_path(self):
        path = resolve_chat_url({"type": "anthropic", "base_url": "https://api.anthropic.com/v1"})
        assert path == "/messages"


# ── Token estimation ──────────────────────────────────────────────────


class TestTokenEstimation:
    def test_empty_string(self):
        assert estimate_tokens("") == 0

    def test_short_text(self):
        result = estimate_tokens("Hello world")
        assert result > 0

    def test_heuristic_fallback(self):
        """Without tiktoken, heuristic should give reasonable estimate."""
        text = "a" * 350  # ~100 tokens at 3.5 chars/token
        result = estimate_tokens(text)
        assert 50 <= result <= 200

    def test_message_tokens(self):
        messages = [
            {"role": "user", "content": "Hello, how are you?"},
            {"role": "assistant", "content": "I'm doing well, thanks!"},
        ]
        result = estimate_message_tokens(messages)
        assert result > 0

    def test_message_tokens_with_content_blocks(self):
        """Anthropic-style content blocks."""
        messages = [
            {"role": "user", "content": [
                {"type": "text", "text": "Hello"},
                {"type": "text", "text": "World"},
            ]},
        ]
        result = estimate_message_tokens(messages)
        assert result > 0

    def test_empty_messages(self):
        assert estimate_message_tokens([]) == 0
