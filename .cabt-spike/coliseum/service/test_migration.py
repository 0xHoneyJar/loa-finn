# test_migration.py — pins the LIVE-board startup migration (owner attribution + viewer `kind`).
#
# WHY: the live persisted leaderboard.json (in the /data volume) predates two display changes:
#   (1) our own entrants carry the placeholder owner 'lab'; the viewer wants honest attribution 'soju';
#   (2) no entrant carries a `kind` field, so the viewer can't render variant/clone/real badges.
# Editing leaderboard.seed.json does NOT fix the live board (the seed is only copied when LB is
# ABSENT, and LB already exists). So a startup migration is needed. It MUST be:
#   - SAFE: the 14 real external gumi bundles + 'Soju Dash' must keep EVERY field untouched (only
#     `kind` ADDED). No corruption of the 15 real submissions.
#   - HONEST: relabelling 'lab'->'soju' MUST NOT inflate the field-trust meter (the meter keys on
#     entrant KIND, not the owner string — already enforced by test_field_trust.py).
#   - IDEMPOTENT: re-running on its own output is a byte-identical no-op (safe to run every boot).
#
# Isolation: app.py imports fastapi + the native engine modules at import time; the migration under
# test touches none of that, so we stub those deps before importing app (same pattern as
# test_field_trust.py) — a fast, hermetic unit test that runs on any platform/CI.
import copy
import json
import os
import sys
import tempfile
import types

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

FIXTURE = os.path.join(HERE, "test_fixtures", "live_leaderboard_20260622.json")


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


# keep app.py's import-time data seeding out of the repo (writes only into a throwaway tmp DATA_DIR)
os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="coliseum-mig-test-"))
_install_stub_modules()
import app  # noqa: E402


def _load_fixture():
    with open(FIXTURE) as f:
        return json.load(f)


# ---- the real live board shape (8 lab + 14 gumi + 1 soju, NO kind anywhere) ------------------------

def test_fixture_is_the_real_unmigrated_board():
    """Guard: the fixture is the real, un-migrated live board — 23 rows, no `kind`, 8 owner 'lab'."""
    lb = _load_fixture()
    ents = lb["entrants"]
    assert len(ents) == 23
    assert all("kind" not in r for r in ents)
    assert sum(1 for r in ents if str(r.get("owner")).lower() == "lab") == 8
    assert sum(1 for r in ents if str(r.get("owner")).lower() == "gumi") == 14
    assert sum(1 for r in ents if str(r.get("owner")).lower() == "soju") == 1


def test_lab_owners_relabelled_to_soju():
    """The 8 ex-'lab' rows become owner 'soju' (display attribution); ZERO 'lab' owners remain."""
    lb = _load_fixture()
    ex_lab_ids = {id(r): r.get("name") for r in lb["entrants"] if str(r.get("owner")).lower() == "lab"}
    ex_lab_names = set(ex_lab_ids.values())
    assert len(ex_lab_names) == 8

    app._migrate_owners_and_kind(lb)

    assert sum(1 for r in lb["entrants"] if str(r.get("owner")).lower() == "lab") == 0
    for r in lb["entrants"]:
        if r.get("name") in ex_lab_names:
            assert r["owner"] == "soju"


def test_count_unchanged_and_real_rows_untouched_except_kind_added():
    """Count stays 23; the 14 gumi rows + 'Soju Dash' keep EVERY original field (no drop/rename/
    reorder-away) — only `kind` is ADDED (appended at the end). Spot-check a known gumi row."""
    before = _load_fixture()
    # snapshot the rows that MUST be preserved verbatim (everything except the ex-'lab' rows)
    preserved_before = {r["id"]: copy.deepcopy(r)
                        for r in before["entrants"]
                        if str(r.get("owner")).lower() != "lab" and r.get("id")}
    assert len(preserved_before) == 15  # 14 gumi + soju-dash

    after = _load_fixture()
    app._migrate_owners_and_kind(after)

    assert len(after["entrants"]) == 23
    after_by_id = {r.get("id"): r for r in after["entrants"]}

    for rid, orig in preserved_before.items():
        cur = after_by_id[rid]
        orig_keys = list(orig.keys())
        # every original field preserved with its exact value
        for k in orig_keys:
            assert cur[k] == orig[k], f"{rid}: field {k!r} mutated"
        # exactly one new key — `kind` — and original key ORDER preserved as a prefix
        assert set(cur.keys()) == set(orig_keys) | {"kind"}, f"{rid}: key set changed beyond +kind"
        assert list(cur.keys())[:len(orig_keys)] == orig_keys, f"{rid}: original field order disturbed"
        assert list(cur.keys())[-1] == "kind", f"{rid}: kind not appended at end"

    # explicit spot-check on the rank-1 gumi bundle: all the load-bearing fields intact
    crustle = after_by_id["gumi-v18-crustle"]
    assert crustle["owner"] == "gumi"
    assert crustle["rank"] == 1
    assert crustle["pilot"] == "bundle"
    assert crustle["elo"] == 1308
    assert crustle["wins"] == 15
    assert crustle["losses"] == 3
    assert crustle["replay"] == "gumi-v18-crustle"


def test_every_entrant_gets_viewer_vocab_kind():
    """Every entrant has `kind` in {'variant','clone','real'} with the right value per pilot+owner:
    14 gumi bundles -> 'real'; 'Soju Dash' (bundle owned by operator soju) -> 'variant';
    clone:* rows -> 'clone'; v4/v5/v6/greedy rows -> 'variant'."""
    lb = _load_fixture()
    app._migrate_owners_and_kind(lb)
    by_name = {r.get("name"): r for r in lb["entrants"]}

    assert all(r["kind"] in {"variant", "clone", "real"} for r in lb["entrants"])

    # the 14 gumi bundles -> 'real'
    gumi = [r for r in lb["entrants"] if r.get("owner") == "gumi"]
    assert len(gumi) == 14
    assert all(r["kind"] == "real" for r in gumi)

    # 'Soju Dash' is a bundle owned by the operator handle 'soju' -> NOT real -> 'variant'
    assert by_name["Soju Dash"]["kind"] == "variant"

    # clone:* sparring rows -> 'clone'
    for n in ("spar-dwebble", "spar-alakazam", "spar-lucario"):
        assert by_name[n]["kind"] == "clone", n

    # variant pilots (v4/v5/v6/greedy) -> 'variant'
    for n in ("champion-dwebble", "v4-abomasnow", "v5-abomasnow", "v6-abomasnow", "greedy-floor"):
        assert by_name[n]["kind"] == "variant", n


def test_field_trust_after_migration_stays_honest():
    """After migrate + recompute (mirrors the boot block), the meter reads BOOTSTRAP keyed on KIND:
    real == 1 (the gumi owner ONLY — 'soju' is an operator handle, excluded even though relabelled),
    trust == 'low'. The disjoint KIND tallies: sparring == 3 (the clones); internal == 6 (the 5
    ex-lab variants + 'Soju Dash'). NB: the 9 self/operator entrants split 6 internal + 3 sparring —
    `_recompute_field_trust` reports internal and sparring DISJOINTLY, so internal is 6, not 9."""
    lb = _load_fixture()
    app._migrate_owners_and_kind(lb)
    app._recompute_field_trust(lb)
    ft = lb["fieldTrust"]
    assert ft["real"] == 1
    assert ft["verified_owners"] == ["gumi"]
    assert ft["trust"] == "low"
    assert ft["sparring"] == 3
    assert ft["internal"] == 6
    assert ft["internal"] + ft["sparring"] == 9  # the 9 self/operator entrants (8 ex-lab + soju-dash)


def test_idempotent_second_call_is_byte_identical():
    """Running the migration a SECOND time on its own output is a no-op: deep-equal AND byte-identical
    (no 'lab' owners remain to relabel; every entrant already has `kind`, which is respected)."""
    lb = _load_fixture()
    out1 = app._migrate_owners_and_kind(lb)
    snapshot = copy.deepcopy(out1)
    out2 = app._migrate_owners_and_kind(out1)
    assert out2 == snapshot
    assert json.dumps(out2, indent=2) == json.dumps(snapshot, indent=2)


def test_idempotent_respects_preexisting_explicit_kind():
    """If a `kind` is already present on a row, the migration leaves it (respect explicit data +
    idempotence) — it does not re-derive over it."""
    lb = _load_fixture()
    lb["entrants"][0]["kind"] = "real"  # deliberately "wrong" explicit value
    name = lb["entrants"][0]["name"]
    app._migrate_owners_and_kind(lb)
    got = next(r for r in lb["entrants"] if r["name"] == name)
    assert got["kind"] == "real"  # preserved, not overwritten
