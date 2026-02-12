"""Provider registry and validation — cherry-picked from loa_cheval/providers/ (SDD §4.2.3).

Provides:
- Supported provider type registry
- Provider config validation
- Default configurations per provider type
- Token estimation (best-effort)
- Health check URL resolution

Note: The cheval sidecar uses httpx directly rather than class-based adapters.
This module provides the metadata and validation layer, not the HTTP transport.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger("cheval.provider_registry")


@dataclass(frozen=True)
class ProviderDefaults:
    """Default configuration for a provider type."""

    connect_timeout_ms: int = 5000
    read_timeout_ms: int = 60000
    total_timeout_ms: int = 300000
    health_path: str = "/models"
    chat_path: str = "/chat/completions"
    auth_header: str = "Authorization"
    auth_prefix: str = "Bearer"
    extra_headers: Dict[str, str] = field(default_factory=dict)


# Provider type → default configuration
_PROVIDER_DEFAULTS: Dict[str, ProviderDefaults] = {
    "openai": ProviderDefaults(),
    "openai_compat": ProviderDefaults(),
    "anthropic": ProviderDefaults(
        health_path="/messages",
        chat_path="/messages",
        auth_header="x-api-key",
        auth_prefix="",
        extra_headers={"anthropic-version": "2023-06-01"},
    ),
}


def get_supported_types() -> List[str]:
    """Return list of supported provider types."""
    return list(_PROVIDER_DEFAULTS.keys())


def is_supported_type(provider_type: str) -> bool:
    """Check if a provider type is supported."""
    return provider_type in _PROVIDER_DEFAULTS


def get_defaults(provider_type: str) -> Optional[ProviderDefaults]:
    """Get default configuration for a provider type.

    Returns None if provider type is not recognized.
    """
    return _PROVIDER_DEFAULTS.get(provider_type)


def validate_provider(provider: Dict[str, Any]) -> List[str]:
    """Validate a provider configuration dict.

    Returns list of error strings (empty = valid).
    """
    errors = []

    name = provider.get("name")
    if not name:
        errors.append("Provider 'name' is required")

    base_url = provider.get("base_url")
    if not base_url:
        errors.append("Provider 'base_url' is required")

    api_key = provider.get("api_key")
    if not api_key:
        errors.append("Provider 'api_key' is required")

    ptype = provider.get("type", "openai")
    if not is_supported_type(ptype):
        errors.append(
            f"Unknown provider type '{ptype}'. "
            f"Supported: {get_supported_types()}"
        )

    return errors


def resolve_auth_headers(provider: Dict[str, Any]) -> Dict[str, str]:
    """Build auth headers for a provider.

    Handles different auth styles (Bearer token vs x-api-key).
    """
    ptype = provider.get("type", "openai")
    api_key = provider.get("api_key", "")
    defaults = get_defaults(ptype) or ProviderDefaults()

    headers: Dict[str, str] = {
        "Content-Type": "application/json",
    }

    if defaults.auth_prefix:
        headers[defaults.auth_header] = f"{defaults.auth_prefix} {api_key}"
    else:
        headers[defaults.auth_header] = api_key

    headers.update(defaults.extra_headers)
    return headers


def resolve_chat_url(provider: Dict[str, Any]) -> str:
    """Resolve the chat completions URL for a provider."""
    ptype = provider.get("type", "openai")
    base_url = provider.get("base_url", "").rstrip("/")
    defaults = get_defaults(ptype) or ProviderDefaults()
    return defaults.chat_path


def estimate_tokens(text: str) -> int:
    """Best-effort token estimation (SDD §4.2.4).

    Priority: tiktoken (OpenAI) > heuristic (len/3.5).
    """
    try:
        import tiktoken
        enc = tiktoken.get_encoding("cl100k_base")
        return len(enc.encode(text))
    except (ImportError, Exception):
        pass

    # Heuristic: ~3.5 chars per token (conservative for English)
    return int(len(text) / 3.5)


def estimate_message_tokens(messages: List[Dict[str, Any]]) -> int:
    """Estimate token count for a list of messages."""
    text = ""
    for msg in messages:
        content = msg.get("content", "")
        if isinstance(content, str):
            text += content
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and "text" in block:
                    text += block["text"]
    return estimate_tokens(text)
