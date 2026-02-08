#!/usr/bin/env python3
"""
cheval.py — Stateless Python model adapter (SDD §4.5, T-14.5, T-14.6)

Machine mode: python3 cheval.py --request <path> --schema-version 1
Human CLI:    python3 cheval.py <agent> <prompt-file> [--model alias]

Exit codes:
  0 = success
  1 = provider returned error (4xx/5xx)
  2 = network/timeout error
  3 = HMAC validation failed
  4 = invalid request (schema violation)
  5 = internal cheval error
"""

import hashlib
import hmac as hmac_mod
import json
import math
import os
import random
import sys
import time
from datetime import datetime, timezone
from typing import Any, Optional

try:
    import httpx
except ImportError:
    print("ERROR: httpx not installed. Run: pip install httpx", file=sys.stderr)
    sys.exit(5)


# === Error Classes ===

class ChevalError(Exception):
    """Structured error with code, provider_code, retryable flag."""

    def __init__(
        self,
        code: str,
        message: str,
        provider_code: Optional[str] = None,
        status_code: Optional[int] = None,
        retryable: bool = False,
    ):
        super().__init__(message)
        self.code = code
        self.provider_code = provider_code
        self.status_code = status_code
        self.retryable = retryable

    def to_dict(self) -> dict:
        return {
            "error": "ChevalError",
            "code": self.code,
            "message": str(self),
            "provider_code": self.provider_code,
            "status_code": self.status_code,
            "retryable": self.retryable,
        }


# === HMAC Validation ===

def verify_hmac(
    body: bytes,
    signature: str,
    secret: str,
    nonce: str,
    trace_id: str,
    issued_at: str,
    skew_seconds: float = 30.0,
) -> bool:
    """Verify HMAC-SHA256 signature with canonical JSON and clock skew check."""
    body_hash = hashlib.sha256(body).hexdigest()
    canonical = json.dumps(
        {
            "body_hash": body_hash,
            "issued_at": issued_at,
            "nonce": nonce,
            "trace_id": trace_id,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    expected = hmac_mod.new(
        secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256
    ).hexdigest()

    if not hmac_mod.compare_digest(signature, expected):
        return False

    # Clock skew validation
    try:
        issued = datetime.fromisoformat(issued_at.replace("Z", "+00:00"))
        delta = abs((datetime.now(timezone.utc) - issued).total_seconds())
        return delta <= skew_seconds
    except (ValueError, TypeError):
        return False


# === Request Building ===

def build_openai_request(request: dict) -> dict:
    """Build OpenAI-compatible HTTP request body from ChevalRequest."""
    body: dict[str, Any] = {
        "model": request["model"],
        "messages": _convert_messages(request["messages"]),
    }

    options = request.get("options", {})
    if options.get("temperature") is not None:
        body["temperature"] = options["temperature"]
    if options.get("top_p") is not None:
        body["top_p"] = options["top_p"]
    if options.get("max_tokens") is not None:
        # Clamp to provider output limit if provided in request
        body["max_tokens"] = options["max_tokens"]
    if options.get("stop"):
        body["stop"] = options["stop"]

    if request.get("tools"):
        body["tools"] = request["tools"]
        if options.get("tool_choice"):
            body["tool_choice"] = options["tool_choice"]

    return body


def _convert_messages(messages: list[dict]) -> list[dict]:
    """Convert canonical messages to OpenAI format."""
    result = []
    for msg in messages:
        converted: dict[str, Any] = {"role": msg["role"]}
        if msg.get("content") is not None:
            converted["content"] = msg["content"]
        elif msg["role"] == "assistant":
            # Null content on tool-call turns — omit content field
            pass
        else:
            converted["content"] = ""

        if msg.get("tool_calls"):
            converted["tool_calls"] = msg["tool_calls"]
        if msg.get("tool_call_id"):
            converted["tool_call_id"] = msg["tool_call_id"]
        if msg.get("name"):
            converted["name"] = msg["name"]

        result.append(converted)
    return result


# === Response Normalization ===

def normalize_response(
    raw: dict, provider_type: str, trace_id: str, latency_ms: float
) -> dict:
    """Normalize provider response to CompletionResult v1.0 schema."""
    choices = raw.get("choices", [])
    if not choices:
        return _empty_result(raw, trace_id, latency_ms)

    message = choices[0].get("message", {})

    content = message.get("content", "") or ""
    thinking = extract_thinking(raw, provider_type)
    tool_calls = _extract_tool_calls(message)
    usage = _extract_usage(raw)

    return {
        "content": content,
        "thinking": thinking,
        "tool_calls": tool_calls,
        "usage": usage,
        "metadata": {
            "model": raw.get("model", ""),
            "provider_request_id": raw.get("id"),
            "latency_ms": latency_ms,
            "trace_id": trace_id,
        },
    }


def extract_thinking(raw: dict, provider_type: str) -> Optional[str]:
    """Extract thinking/reasoning trace. Returns None for non-thinking models."""
    choices = raw.get("choices", [])
    if not choices:
        return None

    message = choices[0].get("message", {})

    # Kimi-K2 / Moonshot: reasoning_content field
    if provider_type in ("openai-compatible",):
        reasoning = message.get("reasoning_content")
        if reasoning and isinstance(reasoning, str) and reasoning.strip():
            return reasoning

    return None


def _extract_tool_calls(message: dict) -> Optional[list[dict]]:
    """Extract and normalize tool calls from message."""
    raw_calls = message.get("tool_calls")
    if not raw_calls:
        return None

    result = []
    for call in raw_calls:
        try:
            if not isinstance(call, dict):
                print(f"WARN: Skipping malformed tool_call: {type(call)}", file=sys.stderr)
                continue
            func = call.get("function", {})
            if not func.get("name"):
                print("WARN: Skipping tool_call with missing function name", file=sys.stderr)
                continue
            result.append({
                "id": call.get("id", f"call_{hashlib.md5(json.dumps(call).encode()).hexdigest()[:8]}"),
                "type": "function",
                "function": {
                    "name": func["name"],
                    "arguments": func.get("arguments", "{}"),
                },
            })
        except (TypeError, KeyError) as e:
            print(f"WARN: Skipping malformed tool_call: {e}", file=sys.stderr)
            continue

    return result if result else None


def _extract_usage(raw: dict) -> dict:
    """Extract usage info with defaults for missing fields."""
    usage = raw.get("usage", {})
    if not isinstance(usage, dict):
        print("WARN: Missing or malformed usage field, defaulting to 0", file=sys.stderr)
        usage = {}

    return {
        "prompt_tokens": usage.get("prompt_tokens", 0) or 0,
        "completion_tokens": usage.get("completion_tokens", 0) or 0,
        "reasoning_tokens": usage.get("reasoning_tokens", 0) or 0,
    }


def _empty_result(raw: dict, trace_id: str, latency_ms: float) -> dict:
    """Return empty result for responses with no choices."""
    return {
        "content": "",
        "thinking": None,
        "tool_calls": None,
        "usage": _extract_usage(raw),
        "metadata": {
            "model": raw.get("model", ""),
            "provider_request_id": raw.get("id"),
            "latency_ms": latency_ms,
            "trace_id": trace_id,
        },
    }


# === Retry Logic (T-14.6) ===

# Non-retryable status codes
NON_RETRYABLE_STATUS = {400, 401, 403, 404}


def invoke_with_retry(
    client: httpx.Client,
    url: str,
    headers: dict,
    body: dict,
    retry_config: dict,
    trace_id: str,
) -> httpx.Response:
    """Invoke HTTP request with exponential backoff and jitter."""
    max_retries = retry_config.get("max_retries", 3)
    base_delay = retry_config.get("base_delay_ms", 1000) / 1000.0
    max_delay = retry_config.get("max_delay_ms", 30000) / 1000.0
    jitter_pct = retry_config.get("jitter_percent", 25) / 100.0
    retryable_codes = set(retry_config.get("retryable_status_codes", [429, 500, 502, 503, 504]))

    last_error: Optional[Exception] = None

    for attempt in range(max_retries + 1):
        if attempt > 0:
            delay = min(base_delay * (2 ** (attempt - 1)), max_delay)
            jitter = delay * jitter_pct * (random.random() * 2 - 1)
            actual_delay = max(0, delay + jitter)
            print(f"RETRY: attempt {attempt + 1}/{max_retries + 1}, delay {actual_delay:.2f}s", file=sys.stderr)
            time.sleep(actual_delay)

        try:
            response = client.post(url, json=body, headers=headers)

            if response.status_code == 200:
                return response

            if response.status_code in NON_RETRYABLE_STATUS:
                raise ChevalError(
                    code="provider_error",
                    message=f"HTTP {response.status_code}: {_safe_error_body(response)}",
                    status_code=response.status_code,
                    retryable=False,
                )

            if response.status_code in retryable_codes:
                last_error = ChevalError(
                    code="provider_error",
                    message=f"HTTP {response.status_code}: {_safe_error_body(response)}",
                    status_code=response.status_code,
                    retryable=True,
                )
                if attempt < max_retries:
                    continue
                raise last_error

            # Unknown status code — don't retry
            raise ChevalError(
                code="provider_error",
                message=f"HTTP {response.status_code}: {_safe_error_body(response)}",
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

    # Should not reach here
    if last_error:
        raise last_error
    raise ChevalError(code="network_error", message="All retries exhausted", retryable=False)


def _safe_error_body(response: httpx.Response) -> str:
    """Extract error message from response body without exposing sensitive data."""
    try:
        data = response.json()
        if isinstance(data, dict):
            error = data.get("error", {})
            if isinstance(error, dict):
                return error.get("message", response.text[:200])
            return str(error)[:200]
        return response.text[:200]
    except Exception:
        return response.text[:200] if response.text else "(empty body)"


# === Machine Mode Entry Point ===

def run_machine_mode(request_path: str, schema_version: int) -> None:
    """Machine mode: read ChevalRequest from file, invoke, write CompletionResult to stdout."""
    if schema_version != 1:
        print(f"ERROR: Unsupported schema version: {schema_version}", file=sys.stderr)
        sys.exit(4)

    # Read request file
    try:
        with open(request_path, "rb") as f:
            body_bytes = f.read()
        request = json.loads(body_bytes)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f"ERROR: Failed to read request: {e}", file=sys.stderr)
        sys.exit(4)

    # Validate HMAC
    hmac_data = request.get("hmac", {})
    hmac_secret = os.environ.get("CHEVAL_HMAC_SECRET", "")
    if not hmac_secret:
        print("ERROR: CHEVAL_HMAC_SECRET not set", file=sys.stderr)
        sys.exit(3)

    skew = float(os.environ.get("CHEVAL_HMAC_SKEW_SECONDS", "30"))

    # Verify using the request body (without hmac field for signing)
    request_for_signing = {k: v for k, v in request.items() if k != "hmac"}
    signing_body = json.dumps(request_for_signing, sort_keys=True, separators=(",", ":")).encode("utf-8")

    # Also try previous secret for zero-downtime rotation
    hmac_secret_prev = os.environ.get("CHEVAL_HMAC_SECRET_PREV", "")
    valid = verify_hmac(
        signing_body,
        hmac_data.get("signature", ""),
        hmac_secret,
        hmac_data.get("nonce", ""),
        request.get("metadata", {}).get("trace_id", ""),
        hmac_data.get("issued_at", ""),
        skew,
    )
    if not valid and hmac_secret_prev:
        valid = verify_hmac(
            signing_body,
            hmac_data.get("signature", ""),
            hmac_secret_prev,
            hmac_data.get("nonce", ""),
            request.get("metadata", {}).get("trace_id", ""),
            hmac_data.get("issued_at", ""),
            skew,
        )

    if not valid:
        print("ERROR: HMAC validation failed", file=sys.stderr)
        sys.exit(3)

    # Extract provider config
    provider = request.get("provider", {})
    base_url = provider.get("base_url", "")
    api_key = provider.get("api_key", "")

    if not base_url or not api_key:
        print("ERROR: Missing provider base_url or api_key", file=sys.stderr)
        sys.exit(4)

    # Build HTTP request
    openai_body = build_openai_request(request)
    url = f"{base_url.rstrip('/')}/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "X-Request-ID": request.get("metadata", {}).get("trace_id", ""),
    }

    # Set up timeouts
    connect_timeout = provider.get("connect_timeout_ms", 5000) / 1000.0
    read_timeout = provider.get("read_timeout_ms", 60000) / 1000.0
    total_timeout = provider.get("total_timeout_ms", 300000) / 1000.0

    retry_config = request.get("retry", {})
    provider_type = provider.get("type", "openai")
    trace_id = request.get("metadata", {}).get("trace_id", "")

    # Invoke with retry
    start_time = time.monotonic()
    try:
        timeout = httpx.Timeout(
            connect=connect_timeout,
            read=read_timeout,
            write=30.0,
            pool=total_timeout,
        )
        with httpx.Client(timeout=timeout) as client:
            response = invoke_with_retry(client, url, headers, openai_body, retry_config, trace_id)
    except ChevalError as e:
        print(json.dumps(e.to_dict()), file=sys.stdout)
        if e.code == "network_error":
            sys.exit(2)
        sys.exit(1)

    latency_ms = (time.monotonic() - start_time) * 1000

    # Parse response
    try:
        raw_response = response.json()
    except json.JSONDecodeError:
        error = ChevalError(
            code="provider_error",
            message=f"Non-JSON response body: {response.text[:200]}",
            retryable=False,
        )
        print(json.dumps(error.to_dict()), file=sys.stdout)
        sys.exit(1)

    # Normalize to CompletionResult
    result = normalize_response(raw_response, provider_type, trace_id, latency_ms)
    print(json.dumps(result))
    sys.exit(0)


# === Human CLI Mode ===

def run_human_mode(agent: str, prompt_file: str, model_alias: Optional[str] = None) -> None:
    """Human CLI mode for manual testing. Loads config from .loa.config.yaml."""
    try:
        import yaml
    except ImportError:
        print("ERROR: pyyaml not installed. Run: pip install pyyaml", file=sys.stderr)
        sys.exit(5)

    # Load config
    config_path = ".loa.config.yaml"
    if not os.path.exists(config_path):
        print(f"ERROR: Config not found: {config_path}", file=sys.stderr)
        sys.exit(4)

    with open(config_path) as f:
        config = yaml.safe_load(f)

    hounfour = config.get("hounfour", {})
    providers = hounfour.get("providers", {})
    aliases = hounfour.get("aliases", {})
    agents = hounfour.get("agents", {})

    # Resolve agent binding
    binding = agents.get(agent, {})
    model_ref = model_alias or binding.get("model", "")
    canonical = aliases.get(model_ref, model_ref)

    parts = canonical.split(":")
    if len(parts) != 2:
        print(f"ERROR: Cannot resolve model '{model_ref}' to provider:model", file=sys.stderr)
        sys.exit(4)

    provider_name, model_id = parts
    provider = providers.get(provider_name)
    if not provider:
        print(f"ERROR: Provider '{provider_name}' not configured", file=sys.stderr)
        sys.exit(4)

    # Resolve API key
    api_key_raw = provider.get("options", {}).get("apiKey", "")
    if api_key_raw.startswith("{env:") and api_key_raw.endswith("}"):
        env_var = api_key_raw[5:-1]
        api_key = os.environ.get(env_var, "")
    else:
        api_key = api_key_raw

    if not api_key:
        print(f"ERROR: No API key for provider '{provider_name}'", file=sys.stderr)
        sys.exit(4)

    # Read prompt file
    with open(prompt_file) as f:
        prompt = f.read()

    base_url = provider.get("options", {}).get("baseURL", "")
    url = f"{base_url.rstrip('/')}/chat/completions"

    openai_body = {
        "model": model_id,
        "messages": [{"role": "user", "content": prompt}],
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    provider_type = provider.get("type", "openai")
    trace_id = f"human-{int(time.time())}"

    # Connection pooling for human CLI mode (T-15.10)
    pool_size = provider.get("options", {}).get("pool_connections", 10)
    pool_limits = httpx.Limits(
        max_connections=pool_size,
        max_keepalive_connections=pool_size,
        keepalive_expiry=30.0,
    )

    start_time = time.monotonic()
    try:
        with httpx.Client(timeout=60.0, limits=pool_limits) as client:
            response = client.post(url, json=openai_body, headers=headers)
            response.raise_for_status()
    except httpx.HTTPStatusError as e:
        print(f"ERROR: HTTP {e.response.status_code}: {_safe_error_body(e.response)}", file=sys.stderr)
        sys.exit(1)
    except httpx.TimeoutException:
        print("ERROR: Request timed out", file=sys.stderr)
        sys.exit(2)

    latency_ms = (time.monotonic() - start_time) * 1000
    raw = response.json()
    result = normalize_response(raw, provider_type, trace_id, latency_ms)

    # Pretty print for human mode
    print(f"\n--- {model_id} ({provider_name}) ---")
    if result["thinking"]:
        print(f"\n[Thinking]\n{result['thinking']}\n")
    print(result["content"])
    print(f"\n--- Tokens: {result['usage']['prompt_tokens']}in/{result['usage']['completion_tokens']}out | {latency_ms:.0f}ms ---")


# === Main Entry Point ===

def main():
    args = sys.argv[1:]

    if not args:
        print("Usage:", file=sys.stderr)
        print("  Machine: python3 cheval.py --request <path> --schema-version 1", file=sys.stderr)
        print("  Human:   python3 cheval.py <agent> <prompt-file> [--model alias]", file=sys.stderr)
        sys.exit(4)

    # Machine mode
    if "--request" in args:
        idx = args.index("--request")
        if idx + 1 >= len(args):
            print("ERROR: --request requires a path argument", file=sys.stderr)
            sys.exit(4)
        request_path = args[idx + 1]

        schema_version = 1
        if "--schema-version" in args:
            sv_idx = args.index("--schema-version")
            if sv_idx + 1 < len(args):
                schema_version = int(args[sv_idx + 1])

        run_machine_mode(request_path, schema_version)
        return

    # Human CLI mode
    if len(args) < 2:
        print("ERROR: Human mode requires <agent> <prompt-file>", file=sys.stderr)
        sys.exit(4)

    agent = args[0]
    prompt_file = args[1]
    model_alias = None
    if "--model" in args:
        m_idx = args.index("--model")
        if m_idx + 1 < len(args):
            model_alias = args[m_idx + 1]

    run_human_mode(agent, prompt_file, model_alias)


if __name__ == "__main__":
    main()
