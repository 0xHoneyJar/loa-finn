"""Tests for config interpolation, deep merge, and redaction (Task 1.12).

Validates:
- {env:VAR} interpolation with allowlist
- {file:path} interpolation with safety checks
- Deep merge semantics
- Secret redaction in configs, headers, and strings
"""

import os
import stat
import sys

import pytest

# Ensure adapters/ is on path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config_loader import (
    REDACTED,
    deep_merge,
    interpolate_config,
    interpolate_value,
    redact_config,
    redact_headers,
    redact_string,
)


# ── Env interpolation ────────────────────────────────────────────────


class TestEnvInterpolation:
    def test_resolve_allowed_env_var(self, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test-key")
        result = interpolate_value("{env:OPENAI_API_KEY}")
        assert result == "sk-test-key"

    def test_resolve_loa_prefixed_var(self, monkeypatch):
        monkeypatch.setenv("LOA_MY_SECRET", "secret123")
        result = interpolate_value("{env:LOA_MY_SECRET}")
        assert result == "secret123"

    def test_resolve_cheval_prefixed_var(self, monkeypatch):
        monkeypatch.setenv("CHEVAL_PORT", "3001")
        result = interpolate_value("{env:CHEVAL_PORT}")
        assert result == "3001"

    def test_reject_disallowed_env_var(self):
        with pytest.raises(ValueError, match="not in the allowlist"):
            interpolate_value("{env:HOME}")

    def test_missing_env_var_raises(self, monkeypatch):
        monkeypatch.delenv("LOA_NONEXISTENT", raising=False)
        with pytest.raises(ValueError, match="is not set"):
            interpolate_value("{env:LOA_NONEXISTENT}")

    def test_passthrough_no_interpolation(self):
        result = interpolate_value("plain string")
        assert result == "plain string"

    def test_mixed_text_and_interpolation(self, monkeypatch):
        monkeypatch.setenv("LOA_HOST", "localhost")
        result = interpolate_value("http://{env:LOA_HOST}:3001")
        assert result == "http://localhost:3001"


# ── File interpolation ────────────────────────────────────────────────


class TestFileInterpolation:
    def test_resolve_file_in_config_d(self, tmp_path):
        config_d = tmp_path / ".loa.config.d"
        config_d.mkdir()
        secret_file = config_d / "api-key.txt"
        secret_file.write_text("sk-from-file\n")
        os.chmod(str(secret_file), 0o600)

        result = interpolate_value(
            f"{{file:{secret_file}}}",
            project_root=str(tmp_path),
        )
        assert result == "sk-from-file"

    def test_reject_file_outside_allowed_dirs(self, tmp_path):
        bad_file = tmp_path / "outside" / "secret.txt"
        bad_file.parent.mkdir()
        bad_file.write_text("secret")
        os.chmod(str(bad_file), 0o600)

        with pytest.raises(ValueError, match="not in allowed directories"):
            interpolate_value(
                f"{{file:{bad_file}}}",
                project_root=str(tmp_path),
            )

    def test_reject_symlink(self, tmp_path):
        config_d = tmp_path / ".loa.config.d"
        config_d.mkdir()
        real_file = config_d / "real.txt"
        real_file.write_text("secret")
        link = config_d / "link.txt"
        link.symlink_to(real_file)

        with pytest.raises(ValueError, match="symlink"):
            interpolate_value(
                f"{{file:{link}}}",
                project_root=str(tmp_path),
            )

    def test_reject_unsafe_permissions(self, tmp_path):
        config_d = tmp_path / ".loa.config.d"
        config_d.mkdir()
        bad_perm = config_d / "world-readable.txt"
        bad_perm.write_text("secret")
        os.chmod(str(bad_perm), 0o644)  # world-readable

        with pytest.raises(ValueError, match="unsafe permissions"):
            interpolate_value(
                f"{{file:{bad_perm}}}",
                project_root=str(tmp_path),
            )

    def test_reject_missing_file(self, tmp_path):
        config_d = tmp_path / ".loa.config.d"
        config_d.mkdir()

        with pytest.raises(ValueError, match="not found"):
            interpolate_value(
                f"{{file:{config_d / 'missing.txt'}}}",
                project_root=str(tmp_path),
            )


# ── Config interpolation ─────────────────────────────────────────────


class TestInterpolateConfig:
    def test_recursive_interpolation(self, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
        config = {
            "providers": {
                "openai": {
                    "api_key": "{env:OPENAI_API_KEY}",
                    "name": "openai-prod",
                }
            }
        }
        result = interpolate_config(config)
        assert result["providers"]["openai"]["api_key"] == "sk-test"
        assert result["providers"]["openai"]["name"] == "openai-prod"

    def test_list_interpolation(self, monkeypatch):
        monkeypatch.setenv("LOA_URL1", "http://a")
        monkeypatch.setenv("LOA_URL2", "http://b")
        config = {"urls": ["{env:LOA_URL1}", "{env:LOA_URL2}", "plain"]}
        result = interpolate_config(config)
        assert result["urls"] == ["http://a", "http://b", "plain"]

    def test_non_string_values_preserved(self):
        config = {"port": 3001, "debug": True, "tags": [1, 2, 3]}
        result = interpolate_config(config)
        assert result == config


# ── Deep merge ────────────────────────────────────────────────────────


class TestDeepMerge:
    def test_simple_overlay(self):
        base = {"a": 1, "b": 2}
        overlay = {"b": 3, "c": 4}
        result = deep_merge(base, overlay)
        assert result == {"a": 1, "b": 3, "c": 4}

    def test_nested_merge(self):
        base = {"x": {"a": 1, "b": 2}, "y": 10}
        overlay = {"x": {"b": 3, "c": 4}}
        result = deep_merge(base, overlay)
        assert result == {"x": {"a": 1, "b": 3, "c": 4}, "y": 10}

    def test_overlay_replaces_non_dict(self):
        base = {"x": {"nested": True}}
        overlay = {"x": "replaced"}
        result = deep_merge(base, overlay)
        assert result["x"] == "replaced"

    def test_no_mutation(self):
        base = {"a": {"b": 1}}
        overlay = {"a": {"c": 2}}
        result = deep_merge(base, overlay)
        assert "c" not in base["a"]
        assert "b" not in overlay["a"]

    def test_empty_overlay(self):
        base = {"a": 1}
        assert deep_merge(base, {}) == {"a": 1}

    def test_empty_base(self):
        overlay = {"a": 1}
        assert deep_merge({}, overlay) == {"a": 1}


# ── Redaction ─────────────────────────────────────────────────────────


class TestRedactConfig:
    def test_redacts_interpolation_tokens(self):
        config = {"api_key": "{env:OPENAI_API_KEY}", "name": "test"}
        result = redact_config(config)
        assert REDACTED in result["api_key"]
        assert "OPENAI_API_KEY" in result["api_key"]
        assert result["name"] == "test"

    def test_redacts_sensitive_keys(self):
        config = {"auth": "sk-real-key", "endpoint": "https://api.openai.com"}
        result = redact_config(config)
        assert result["auth"] == REDACTED
        assert result["endpoint"] == "https://api.openai.com"

    def test_redacts_nested_secrets(self):
        config = {
            "providers": {
                "openai": {
                    "api_key": "sk-secret",
                    "base_url": "https://api.openai.com",
                }
            }
        }
        result = redact_config(config)
        assert result["providers"]["openai"]["api_key"] == REDACTED
        assert result["providers"]["openai"]["base_url"] == "https://api.openai.com"


class TestRedactHeaders:
    def test_redacts_authorization(self):
        headers = {
            "Authorization": "Bearer sk-secret",
            "Content-Type": "application/json",
        }
        result = redact_headers(headers)
        assert result["Authorization"] == REDACTED
        assert result["Content-Type"] == "application/json"

    def test_redacts_api_key_header(self):
        headers = {"x-api-key": "sk-ant-secret"}
        result = redact_headers(headers)
        assert result["x-api-key"] == REDACTED


class TestRedactString:
    def test_redacts_bearer_token(self):
        text = "Authorization: Bearer sk-test123 was sent"
        result = redact_string(text)
        assert "sk-test123" not in result
        assert REDACTED in result

    def test_redacts_xapi_key(self):
        text = "x-api-key: sk-ant-secret123"
        result = redact_string(text)
        assert "sk-ant-secret123" not in result

    def test_redacts_known_env_values(self, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "sk-real-secret")
        text = "Error with sk-real-secret in message"
        result = redact_string(text)
        assert "sk-real-secret" not in result
        assert REDACTED in result

    def test_plain_string_unchanged(self):
        text = "Just a normal error message"
        assert redact_string(text) == text
