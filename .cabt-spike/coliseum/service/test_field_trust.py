# test_field_trust.py — pins the field-trust HONESTY invariant (GAMES-014).
#
# THE INVARIANT: the meter classifies a field by entrant KIND (derived from the `pilot` prefix +
# an operator-owner EXCLUSION), NOT by the owner string being in an allowlist alone. So relabelling
# our own entrants' display owner 'lab'->'soju' MUST NOT flip the meter SYNTHETIC->TRUSTWORTHY:
# a field of OUR OWN variants + imitation clones cannot reproduce the ladder, so it MUST read
# SYNTHETIC regardless of display owner. Only a DIVERSE EXTERNAL teammate (a different person,
# e.g. gumi) counts as real. These tests were RED against the pre-fix app.py.
#
# Isolation: app.py imports fastapi + the engine modules (validate/match_runner/ranker, which load
# the native Linux-only cg .so) at import time; the field-trust meter under test touches none of
# that, so we stub those deps before importing app — a fast, hermetic unit test that runs on any
# platform/CI without fastapi or the engine. We still import the REAL `_recompute_field_trust`.
import os
import sys
import types
import tempfile

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)


def _install_stub_modules():
    if "fastapi" not in sys.modules:
        fa = types.ModuleType("fastapi")

        class _App:
            def __init__(self, *a, **k):
                pass

            def add_middleware(self, *a, **k):
                pass

            def _decor(self, *a, **k):
                def wrap(fn):
                    return fn
                return wrap

            get = post = delete = put = _decor

        fa.FastAPI = _App
        fa.UploadFile = type("UploadFile", (), {})
        fa.File = lambda *a, **k: None
        fa.Form = lambda *a, **k: None
        sys.modules["fastapi"] = fa

        mw = types.ModuleType("fastapi.middleware")
        cors = types.ModuleType("fastapi.middleware.cors")
        cors.CORSMiddleware = type("CORSMiddleware", (), {})
        mw.cors = cors
        sys.modules["fastapi.middleware"] = mw
        sys.modules["fastapi.middleware.cors"] = cors

        resp = types.ModuleType("fastapi.responses")
        resp.JSONResponse = lambda *a, **k: None
        resp.FileResponse = lambda *a, **k: None
        sys.modules["fastapi.responses"] = resp

    for name, attrs in (("validate", ("validate_bundle", "find_bundle_root")),
                        ("match_runner", ()),
                        ("ranker", ("rank_submission",))):
        if name not in sys.modules:
            m = types.ModuleType(name)
            for a in attrs:
                setattr(m, a, lambda *args, **kw: None)
            sys.modules[name] = m


# keep app.py's import-time data seeding out of the repo
os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="coliseum-test-"))
_install_stub_modules()
import app  # noqa: E402


def _entrant(name, owner, pilot, sparring=False, **extra):
    """Shape an entrant like the seed (name, owner, pilot, sparring, elo, wins, losses, winPct)."""
    e = {"name": name, "owner": owner, "pilot": pilot, "sparring": sparring,
         "elo": None, "wins": 0, "losses": 0, "winPct": 0}
    e.update(extra)
    return e


def _self_only_field():
    """Our own field after the lab->soju relabel: variants + greedy + clones, ALL owner 'soju'."""
    return {"entrants": [
        _entrant("champion-dwebble", "soju", "v4"),
        _entrant("v4-abomasnow", "soju", "v4"),
        _entrant("v5-abomasnow", "soju", "v5"),
        _entrant("v6-abomasnow", "soju", "v6"),
        _entrant("greedy-floor", "soju", "greedy"),
        _entrant("spar-dwebble", "soju", "clone:dwebble_crustle", sparring=True),
        _entrant("spar-lucario", "soju", "clone:lucario", sparring=True),
        _entrant("spar-alakazam", "soju", "clone:alakazam", sparring=True),
    ]}


def test_self_only_field_reads_synthetic_after_relabel():
    """(a) THE load-bearing case: relabel lab->soju MUST NOT flip the meter. Our own variants +
    greedy + clones, all owner 'soju', read SYNTHETIC (trust 'none', real 0)."""
    lb = _self_only_field()
    app._recompute_field_trust(lb)
    assert lb["fieldTrust"]["trust"] == "none"
    assert lb["fieldTrust"]["real"] == 0


def test_own_bundle_does_not_count_as_real():
    """(b) A bundle WE submit under our own operator handle 'soju' is not a diverse external
    teammate — it must not increment real even though 'soju' is in KNOWN_OWNERS."""
    lb = _self_only_field()
    lb["entrants"].append(_entrant("my-bundle", "soju", "bundle"))
    app._recompute_field_trust(lb)
    assert lb["fieldTrust"]["real"] == 0
    assert lb["fieldTrust"]["trust"] == "none"


def test_external_teammate_counts_as_real():
    """(c) A real, external, allowlisted teammate (gumi, in the default KNOWN_OWNERS) submitting a
    bundle DOES count → BOOTSTRAP (trust 'low')."""
    lb = _self_only_field()
    lb["entrants"].append(_entrant("gumi-bundle", "gumi", "bundle"))
    app._recompute_field_trust(lb)
    assert lb["fieldTrust"]["real"] >= 1
    assert lb["fieldTrust"]["trust"] == "low"


def test_freetext_owner_cannot_spoof_real():
    """(d) Anti-spoof (preserve F13): a bundle with a free-text, non-allowlisted owner ('rice')
    does NOT count as real."""
    lb = _self_only_field()
    lb["entrants"].append(_entrant("rice-bundle", "rice", "bundle"))
    app._recompute_field_trust(lb)
    assert lb["fieldTrust"]["real"] == 0
    assert lb["fieldTrust"]["trust"] == "none"


def test_three_distinct_external_owners_are_trustworthy(monkeypatch):
    """(e) ≥3 distinct external allowlisted real owners → TRUSTWORTHY (high). 'soju' is operator-
    owned so it does NOT count even though it's in the allowlist."""
    monkeypatch.setenv("KNOWN_OWNERS", "soju,gumi,alice,bob")
    lb = _self_only_field()
    lb["entrants"].append(_entrant("gumi-bundle", "gumi", "bundle"))
    lb["entrants"].append(_entrant("alice-bundle", "alice", "bundle"))
    lb["entrants"].append(_entrant("bob-bundle", "bob", "bundle"))
    lb["entrants"].append(_entrant("soju-bundle", "soju", "bundle"))  # operator: must NOT count
    app._recompute_field_trust(lb)
    assert lb["fieldTrust"]["real"] == 3
    assert lb["fieldTrust"]["trust"] == "high"
