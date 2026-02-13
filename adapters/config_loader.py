"""Config interpolation, deep merge, and redaction — cherry-picked from loa_cheval/config/ (SDD §4.1.1, §4.1.3, §6.2).

Provides:
- {env:VAR} secret interpolation with allowlist enforcement
- {file:path} secret file reading with safety checks
- Deep merge for layered config
- Redaction for safe logging (never leak secrets)

Note: The cheval sidecar receives config via HTTP request body from loa-finn.
Secret interpolation resolves {env:...} references to actual values at runtime.
"""

from __future__ import annotations

import copy
import logging
import os
import re
import stat
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

logger = logging.getLogger("cheval.config_loader")

# Redaction sentinel
REDACTED = "***REDACTED***"

# Core allowlist for env var interpolation
_CORE_ENV_PATTERNS = [
    re.compile(r"^LOA_"),
    re.compile(r"^OPENAI_API_KEY$"),
    re.compile(r"^ANTHROPIC_API_KEY$"),
    re.compile(r"^MOONSHOT_API_KEY$"),
    re.compile(r"^CHEVAL_"),
]

# Regex for interpolation tokens: {env:VAR}, {file:/path}
_INTERP_RE = re.compile(r"\{(env|file):([^}]+)\}")

# Patterns that indicate sensitive keys (for redaction)
_SENSITIVE_KEY_RE = re.compile(
    r"(auth|key|secret|token|password|credential|bearer)",
    re.IGNORECASE,
)


# ── Env allowlist ─────────────────────────────────────────────────────


def _check_env_allowed(
    var_name: str, extra_patterns: List[re.Pattern] = ()
) -> bool:
    """Check if env var name is in the allowlist."""
    for pattern in _CORE_ENV_PATTERNS:
        if pattern.search(var_name):
            return True
    for pattern in extra_patterns:
        if pattern.search(var_name):
            return True
    return False


# ── File safety ───────────────────────────────────────────────────────


def _check_file_allowed(
    file_path: str,
    project_root: str = ".",
    allowed_dirs: List[str] = (),
) -> str:
    """Validate and resolve a file path for secret reading.

    Returns the resolved absolute path.
    Raises ValueError on validation failure.
    """
    path = Path(file_path)

    if not path.is_absolute():
        path = Path(project_root) / path

    resolved = path.resolve()

    if path.is_symlink():
        raise ValueError(f"Secret file must not be a symlink: {file_path}")

    config_d = Path(project_root) / ".loa.config.d"
    allowed = [config_d] + [Path(d) for d in allowed_dirs]

    in_allowed = False
    for allowed_dir in allowed:
        try:
            resolved.relative_to(allowed_dir.resolve())
            in_allowed = True
            break
        except ValueError:
            continue

    if not in_allowed:
        raise ValueError(
            f"Secret file '{file_path}' not in allowed directories. "
            f"Allowed: .loa.config.d/ or paths in hounfour.secret_paths"
        )

    # Reject symlinks to prevent path traversal (BB-063-007).
    # Note: TOCTOU exists between this check and open(). For full protection,
    # callers should use O_NOFOLLOW when opening the returned path.
    if resolved.is_symlink():
        raise ValueError(
            f"Secret file is a symlink (rejected for security): {resolved}"
        )

    if not resolved.is_file():
        raise ValueError(f"Secret file not found: {resolved}")

    file_stat = resolved.stat()
    if file_stat.st_uid != os.getuid():
        raise ValueError(f"Secret file not owned by current user: {resolved}")

    mode = stat.S_IMODE(file_stat.st_mode)
    if mode & 0o137:
        raise ValueError(
            f"Secret file has unsafe permissions ({oct(mode)}): {resolved}. "
            f"Must be <= 0640"
        )

    return str(resolved)


# ── Interpolation ─────────────────────────────────────────────────────


def interpolate_value(
    value: str,
    project_root: str = ".",
    extra_env_patterns: List[re.Pattern] = (),
    allowed_file_dirs: List[str] = (),
) -> str:
    """Resolve interpolation tokens in a string value.

    Supports:
      {env:VAR_NAME} — read from environment (allowlisted)
      {file:/path}   — read from file (restricted directories)
    """

    def _replace(match: re.Match) -> str:
        source_type = match.group(1)
        source_ref = match.group(2)

        if source_type == "env":
            if not _check_env_allowed(source_ref, extra_env_patterns):
                raise ValueError(
                    f"Environment variable '{source_ref}' is not in the allowlist. "
                    f"Allowed: ^LOA_.*, ^OPENAI_API_KEY$, ^ANTHROPIC_API_KEY$, "
                    f"^MOONSHOT_API_KEY$, ^CHEVAL_.*"
                )
            val = os.environ.get(source_ref)
            if val is None:
                raise ValueError(f"Environment variable '{source_ref}' is not set")
            return val

        elif source_type == "file":
            resolved_path = _check_file_allowed(
                source_ref, project_root, allowed_file_dirs
            )
            return Path(resolved_path).read_text().strip()

        raise ValueError(f"Unknown interpolation type: {source_type}")

    return _INTERP_RE.sub(_replace, value)


def interpolate_config(
    config: Dict[str, Any],
    project_root: str = ".",
    extra_env_patterns: List[re.Pattern] = (),
    allowed_file_dirs: List[str] = (),
) -> Dict[str, Any]:
    """Recursively interpolate all string values in a config dict.

    Returns a new dict with resolved values.
    """
    result = {}
    for key, value in config.items():
        if isinstance(value, str) and _INTERP_RE.search(value):
            result[key] = interpolate_value(
                value, project_root, extra_env_patterns, allowed_file_dirs
            )
        elif isinstance(value, dict):
            result[key] = interpolate_config(
                value, project_root, extra_env_patterns, allowed_file_dirs
            )
        elif isinstance(value, list):
            result[key] = [
                (
                    interpolate_config(
                        item, project_root, extra_env_patterns, allowed_file_dirs
                    )
                    if isinstance(item, dict)
                    else interpolate_value(
                        item, project_root, extra_env_patterns, allowed_file_dirs
                    )
                    if isinstance(item, str) and _INTERP_RE.search(item)
                    else item
                )
                for item in value
            ]
        else:
            result[key] = value
    return result


# ── Deep merge ────────────────────────────────────────────────────────


def deep_merge(base: Dict[str, Any], overlay: Dict[str, Any]) -> Dict[str, Any]:
    """Deep merge overlay into base. Overlay values win.

    Returns a new dict (base and overlay are not modified).
    """
    result = copy.deepcopy(base)
    for key, value in overlay.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


# ── Redaction ─────────────────────────────────────────────────────────


def redact_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """Create a redacted copy of config for display/logging.

    Values sourced from {env:} or {file:} show '***REDACTED***'.
    Keys matching sensitive patterns are also redacted.
    """
    result = {}
    for key, value in config.items():
        if isinstance(value, dict):
            result[key] = redact_config(value)
        elif isinstance(value, str) and _INTERP_RE.search(value):
            sources = _INTERP_RE.findall(value)
            annotations = ", ".join(f"{t}:{r}" for t, r in sources)
            result[key] = f"{REDACTED} (from {annotations})"
        elif _SENSITIVE_KEY_RE.search(key):
            result[key] = REDACTED
        else:
            result[key] = value
    return result


def redact_headers(headers: Dict[str, str]) -> Dict[str, str]:
    """Return a copy of headers with sensitive values redacted."""
    redacted = {}
    for key, value in headers.items():
        if _SENSITIVE_KEY_RE.search(key):
            redacted[key] = REDACTED
        else:
            redacted[key] = value
    return redacted


def redact_string(value: str) -> str:
    """Redact known secret patterns from a string.

    Replaces known env var values and auth headers.
    """
    result = value

    # Redact known secret env vars
    for env_var in ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "MOONSHOT_API_KEY"]:
        env_val = os.environ.get(env_var)
        if env_val and env_val in result:
            result = result.replace(env_val, REDACTED)

    for key, val in os.environ.items():
        if key.startswith("LOA_") and val and len(val) > 8 and val in result:
            result = result.replace(val, REDACTED)

    # Authorization headers
    result = re.sub(
        r"(Authorization:\s*Bearer\s+)\S+", rf"\1{REDACTED}", result, flags=re.IGNORECASE
    )
    result = re.sub(
        r"(x-api-key:\s*)\S+", rf"\1{REDACTED}", result, flags=re.IGNORECASE
    )

    return result
