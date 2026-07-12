# app.py — the Coliseum intake service. Teammates POST their EXACT Kaggle submission.tar.gz (via the
# website upload form or `cabt-submit --url`); the service validates it isolated, then a single
# serialized worker thread fights it against the in-process champion in the real cg engine and ranks it.
#
# Concurrency (SDD-lite Decision 2): the cg engine is a process-global singleton, so ONE worker thread
# owns it AND all state writes — /submit returns fast (<2s), the match runs in the background, and the
# leaderboard read-modify-write race is gone by construction (single writer).
#
# Endpoints: GET /health · GET /leaderboard · GET /entrants · GET /replays/{id} · POST /submit
import json, os, queue, shutil, tarfile, threading, time
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from validate import validate_bundle, find_bundle_root
import match_runner
import ranker

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.join(HERE, "engine")
DATA = os.environ.get("DATA_DIR", os.path.join(HERE, "data"))
BUNDLES = os.path.join(DATA, "bundles")
REPLAYS = os.path.join(DATA, "replays")
LB = os.path.join(DATA, "leaderboard.json")
ENTRANTS = os.path.join(DATA, "entrants.json")
SEED = os.path.join(HERE, "leaderboard.seed.json")
os.makedirs(BUNDLES, exist_ok=True)
os.makedirs(REPLAYS, exist_ok=True)
if not os.path.exists(LB) and os.path.exists(SEED):
    shutil.copy(SEED, LB)
# Seed baked-in demo replays into the data dir so the API can serve them (e.g. the champion's
# watchable demo match) — fixes the leaderboard "watch" 404 for seed entrants.
REPLAY_SEED = os.path.join(HERE, "replays_seed")
if os.path.isdir(REPLAY_SEED):
    for _fn in os.listdir(REPLAY_SEED):
        _dst = os.path.join(REPLAYS, _fn)
        if not os.path.exists(_dst):
            shutil.copy(os.path.join(REPLAY_SEED, _fn), _dst)
# Idempotent migration: older/persisted leaderboards stored `replay` as a viewer-local filename
# ("x.json"); the API serves by BARE id, so strip the extension (fixes the persisted "watch" 404).
if os.path.exists(LB):
    try:
        _lb = json.load(open(LB))
        _changed = False
        for _r in _lb.get("entrants", []):
            if isinstance(_r.get("replay"), str) and _r["replay"].endswith(".json"):
                _r["replay"] = _r["replay"][:-5]
                _changed = True
        if _changed:
            json.dump(_lb, open(LB, "w"), indent=2)
    except Exception:
        pass

app = FastAPI(title="CABT Coliseum Intake")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

JOBS: "queue.Queue[str]" = queue.Queue()
_STATE_LOCK = threading.Lock()   # serializes file writes between /submit (register) and the worker


def _read(path, default):
    try:
        return json.load(open(path))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def _write(path, obj):
    tmp = f"{path}.tmp"
    json.dump(obj, open(tmp, "w"), indent=2)
    os.replace(tmp, path)


def _safe(s: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "-" for c in s.strip().lower())[:48] or "entrant"


def _safe_extract(tar_path, dest):
    """F1: extract an UNTRUSTED tar safely. Default extractall on 3.12 is 'fully_trusted' (allows
    `..`/abs/symlinks → arbitrary write as root). Pre-scan + reject traversal/abs/symlink/device
    members + cap count & uncompressed size, then extract with the hardened 'data' filter."""
    root = os.path.realpath(dest)
    with tarfile.open(tar_path, "r:gz") as t:
        members = t.getmembers()
        if len(members) > 4000:
            raise ValueError("too many members")
        total = 0
        for m in members:
            if m.issym() or m.islnk() or m.ischr() or m.isblk() or m.isfifo() or m.isdev():
                raise ValueError(f"disallowed member type: {m.name}")
            target = os.path.realpath(os.path.join(dest, m.name))
            if target != root and not target.startswith(root + os.sep):
                raise ValueError(f"path traversal: {m.name}")
            total += max(0, m.size)
            if total > 200 * 1024 * 1024:
                raise ValueError("uncompressed too large")
        t.extractall(dest, filter="data")


def _clean(s, n=48):
    """Strip control chars + cap length on agent-/form-supplied text (defense-in-depth; the viewer
    Svelte-escapes on render and the agent can't inject replay strings — it returns only pick indices)."""
    return "".join(c for c in (s or "").strip() if c.isprintable())[:n]


def _entrant_kind(pilot, owner, known, operator):
    """Classify an entrant by KIND (GAMES-014 honesty rule). Keyed on the `pilot` prefix + an
    operator-owner EXCLUSION — NOT on the owner string being in an allowlist alone. Relabelling our
    own entrants 'lab'->'soju' therefore CANNOT flip the meter: only a bundle from a DIVERSE EXTERNAL
    teammate (allowlisted AND not one of our operator handles/placeholders) counts as 'real'.

    Must stay byte-identical to coliseum.py:_entrant_kind (the two twins kept in sync)."""
    if pilot.startswith("clone"):
        return "sparring"
    if pilot.startswith("bundle") and owner in known and owner not in operator:
        return "real"
    return "internal"


def _recompute_field_trust(lb):
    """Live field-trust verdict, keyed on entrant KIND. F13 (anti-spoof) preserved: a free-text owner
    can't spoof the meter. GAMES-014 (honesty): our OWN variants/clones/bundles — even relabelled to a
    real-looking owner like 'soju' — read SYNTHETIC; only DIVERSE EXTERNAL teammates count as real."""
    known = {o.strip().lower() for o in os.environ.get("KNOWN_OWNERS", "soju,gumi").split(",") if o.strip()}
    operator = {o.strip().lower() for o in os.environ.get("OPERATOR_OWNERS", "soju,lab,internal").split(",") if o.strip()}
    ents = lb.get("entrants", [])

    def kind_of(r):
        return _entrant_kind(str(r.get("pilot") or "").lower(), str(r.get("owner") or "").lower(), known, operator)

    # real = number of DISTINCT owners among 'real'-kind entrants
    verified = sorted({r.get("owner") for r in ents if kind_of(r) == "real"})
    # bundle entrants claiming to be real but not allowlisted (anti-spoof surfacing), our own placeholders excluded
    unverified = sorted({r.get("owner") for r in ents
                         if str(r.get("pilot") or "").lower().startswith("bundle")
                         and kind_of(r) != "real" and str(r.get("owner") or "").lower() not in operator})
    real = len(verified)
    if real >= 3:
        trust, verdict = "high", f"TRUSTWORTHY — {real} distinct diverse external teammate owner(s) ({', '.join(verified)})."
    elif real >= 1:
        trust, verdict = "low", f"BOOTSTRAP — {real} diverse external teammate owner(s) ({', '.join(verified)}); ≥3 to trust the ranking."
    else:
        trust, verdict = "none", "SYNTHETIC — no diverse external teammate agents; field is our own variants + clones. Recruit real teammate agents."
    lb["fieldTrust"] = {"trust": trust, "verdict": verdict, "real": real,
                        "verified_owners": verified, "unverified_owners": unverified,
                        "internal": sum(1 for r in ents if kind_of(r) == "internal"),
                        "sparring": sum(1 for r in ents if kind_of(r) == "sparring")}


# Maps the meter's internal KIND vocab -> the viewer's badge vocab. Single source: the meter
# classifier (_entrant_kind) decides; this just renames its output for the UI. No third classifier.
_KIND_VIEWER = {"internal": "variant", "sparring": "clone", "real": "real"}


def _migrate_owners_and_kind(lb):
    """Idempotent DISPLAY migration for the LIVE persisted leaderboard (GAMES-014 honesty surfacing).
    Two pure attribution edits per entrant, NOTHING else touched:
      (1) relabel our own placeholder owner 'lab' -> 'soju' (attribution only — the field-trust meter
          keys on entrant KIND, not the owner string, so this CANNOT inflate the meter); and
      (2) stamp a viewer-vocab `kind` ({'variant','clone','real'}) derived from the SAME _entrant_kind
          classifier the meter uses (no divergent third classifier). A `kind` already present is left
          as-is (respect explicit data + idempotence).
    Mutates and returns lb. Idempotent: re-running on its own output is byte-identical (no 'lab' owners
    remain to relabel; every entrant already carries `kind`). Every other field is preserved verbatim."""
    known = {o.strip().lower() for o in os.environ.get("KNOWN_OWNERS", "soju,gumi").split(",") if o.strip()}
    operator = {o.strip().lower() for o in os.environ.get("OPERATOR_OWNERS", "soju,lab,internal").split(",") if o.strip()}
    for r in lb.get("entrants", []):
        if str(r.get("owner")).lower() == "lab":
            r["owner"] = "soju"
        if "kind" not in r:
            k = _entrant_kind(str(r.get("pilot") or "").lower(), str(r.get("owner") or "").lower(), known, operator)
            r["kind"] = _KIND_VIEWER[k]
    return lb


# Idempotent boot migration (GAMES-014): the LIVE persisted board predates owner-attribution + the
# viewer `kind` field, and editing the seed can't fix it (the seed is only copied when LB is ABSENT).
# So on every boot, if LB exists, relabel 'lab'->'soju' + stamp `kind` (cannot inflate the meter) and
# recompute the live field-trust verdict. Placed AFTER the helper defs above (a block at the replay-id
# migration site would NameError on _write/_recompute and silently skip). Crash-safe: a malformed LB
# never blocks boot (same guarded try/except style as the replay-id migration).
if os.path.exists(LB):
    try:
        _lb = json.load(open(LB))
        _migrate_owners_and_kind(_lb)
        _recompute_field_trust(_lb)
        _write(LB, _lb)
    except Exception:
        pass


def _register(name, owner, sid, bundle_root, smoke):
    with _STATE_LOCK:
        ents = [e for e in _read(ENTRANTS, []) if e.get("id") != sid]
        ents.append({"id": sid, "name": name, "owner": owner, "bundleRoot": bundle_root,
                     "validatedAt": int(time.time()), "smoke": smoke, "status": "queued"})
        _write(ENTRANTS, ents)
        lb = _read(LB, {"entrants": []})
        lb.setdefault("entrants", [])
        lb["entrants"] = [r for r in lb["entrants"] if r.get("id") != sid]
        lb["entrants"].append({"id": sid, "rank": None, "name": name, "owner": owner, "pilot": "bundle",
                               "elo": None, "wins": 0, "losses": 0, "winPct": 0, "sparring": False,
                               "status": "queued · awaiting champion match", "replay": None})
        _recompute_field_trust(lb)
        _write(LB, lb)


def _patch(sid, ent_fields, lb_fields, rerank=False):
    with _STATE_LOCK:
        ents = _read(ENTRANTS, [])
        for e in ents:
            if e.get("id") == sid:
                e.update(ent_fields)
        _write(ENTRANTS, ents)
        lb = _read(LB, {"entrants": []})
        for r in lb.get("entrants", []):
            if r.get("id") == sid:
                r.update(lb_fields)
        if rerank:
            ranked = sorted((r for r in lb["entrants"] if isinstance(r.get("elo"), (int, float))), key=lambda r: -r["elo"])
            for i, r in enumerate(ranked, 1):
                r["rank"] = i
        _write(LB, lb)


def _run_match_job(sid):
    e = next((x for x in _read(ENTRANTS, []) if x.get("id") == sid), None)
    if not e:
        return
    _patch(sid, {"status": "running"}, {"status": "running · fighting the field"})
    deck_path = os.path.join(e["bundleRoot"], "deck.csv")
    result, replay = ranker.rank_submission(e["bundleRoot"], deck_path, n_per_seat=3)
    replay_id = None
    if replay:
        _write(os.path.join(REPLAYS, f"{sid}.json"), replay)
        replay_id = sid
    decisive = result["decisive"]
    status = (f"ranked · Elo {result['elo']} ({result['wins']}-{result['losses']} vs field)" if decisive
              else "no decisive match (agent forfeited)")
    _patch(sid,
           {"status": "ranked" if decisive else "error", "result": result},
           {"status": status, "elo": result["elo"], "wins": result["wins"],
            "losses": result["losses"], "winPct": result["winPct"], "replay": replay_id,
            "perOpponent": result.get("perOpponent")},
           rerank=True)
    # field-trust may shift (a new ranked real owner) — recompute on the live leaderboard
    with _STATE_LOCK:
        lb = _read(LB, {"entrants": []}); _recompute_field_trust(lb); _write(LB, lb)


def _worker_loop():
    while True:  # F9: the worker thread must NEVER die — guard the whole body, incl. the error path
        try:
            sid = JOBS.get()
            try:
                _run_match_job(sid)
            except Exception as ex:
                try:
                    _patch(sid, {"status": "error", "error": str(ex)}, {"status": f"error: {str(ex)[:80]}"})
                except Exception:
                    pass
            finally:
                JOBS.task_done()
        except Exception:
            pass


# Single serialized worker (owns cg + all writes). Re-enqueue interrupted jobs on (re)start.
threading.Thread(target=_worker_loop, daemon=True).start()
for _e in _read(ENTRANTS, []):
    if _e.get("status") in ("queued", "running"):
        JOBS.put(_e["id"])


@app.get("/health")
def health():
    return {"ok": True, "engine": os.path.isdir(os.path.join(ENGINE, "cg")),
            "entrants": len(_read(ENTRANTS, [])), "queued": JOBS.qsize()}


@app.get("/leaderboard")
def leaderboard():
    return JSONResponse(_read(LB, {"entrants": []}))


@app.get("/entrants")
def entrants():
    pub = [{k: v for k, v in e.items() if k != "bundleRoot"} for e in _read(ENTRANTS, [])]
    return JSONResponse(pub)


@app.get("/replays/{rid}")
def replay(rid: str):
    path = os.path.join(REPLAYS, f"{_safe(rid)}.json")
    if not os.path.exists(path):
        return JSONResponse({"error": "replay not found"}, status_code=404)
    return FileResponse(path, media_type="application/json")


@app.delete("/entrants/{eid}")
def delete_entrant(eid: str, token: str = ""):
    """Admin: purge an entrant (e.g. a test/fake) from leaderboard + entrants + its bundle/replay. F11 cleanup."""
    admin = os.environ.get("ADMIN_TOKEN", "")
    if not admin or token != admin:
        return JSONResponse({"ok": False, "message": "admin token required"}, status_code=403)
    sid = _safe(eid)
    with _STATE_LOCK:
        _write(ENTRANTS, [e for e in _read(ENTRANTS, []) if e.get("id") != sid])
        lb = _read(LB, {"entrants": []})
        lb["entrants"] = [r for r in lb.get("entrants", []) if r.get("id") != sid]
        _recompute_field_trust(lb)
        _write(LB, lb)
    shutil.rmtree(os.path.join(BUNDLES, sid), ignore_errors=True)
    for p in (os.path.join(BUNDLES, sid + ".tar.gz"), os.path.join(REPLAYS, sid + ".json")):
        try:
            os.remove(p)
        except OSError:
            pass
    return {"ok": True, "deleted": sid}


@app.get("/entrants/{eid}/bundle")
def export_bundle(eid: str, token: str = ""):
    """Admin: export an entrant's raw bundle tar.gz — farm-the-field (study what beats us, internal team)."""
    admin = os.environ.get("ADMIN_TOKEN", "")
    if not admin or token != admin:
        return JSONResponse({"ok": False, "message": "admin token required"}, status_code=403)
    sid = _safe(eid)
    p = os.path.join(BUNDLES, f"{sid}.tar.gz")
    if not os.path.exists(p):
        return JSONResponse({"error": "bundle not found"}, status_code=404)
    return FileResponse(p, media_type="application/gzip", filename=f"{sid}.tar.gz")


# F8: sync endpoint → Starlette runs it in a threadpool, so the blocking work (tar extract +
# validate subprocess) never stalls the event loop (which was starving /health → Railway restarts).
@app.post("/submit")
def submit(name: str = Form(...), owner: str = Form(...), bundle: UploadFile = File(...)):
    name, owner = _clean(name), _clean(owner, 32)
    if not name or not owner:
        return JSONResponse({"ok": False, "message": "name and owner are required."}, status_code=400)
    if owner.strip().lower() in ("lab", "internal"):
        return JSONResponse({"ok": False, "message": "Pick a real owner handle (not 'lab'/'internal') — real entrants are the point."}, status_code=400)
    sid = _safe(name)
    raw = bundle.file.read()
    if len(raw) > 50 * 1024 * 1024:
        return JSONResponse({"ok": False, "message": "Bundle too large (>50MB)."}, status_code=413)
    tar_path = os.path.join(BUNDLES, f"{sid}.tar.gz")
    bdir = os.path.join(BUNDLES, sid)
    with open(tar_path, "wb") as f:
        f.write(raw)
    shutil.rmtree(bdir, ignore_errors=True)
    os.makedirs(bdir, exist_ok=True)
    try:
        _safe_extract(tar_path, bdir)
    except Exception:
        return JSONResponse({"ok": False, "message": "Couldn't read the bundle (invalid or unsafe tar.gz)."}, status_code=400)
    root = find_bundle_root(bdir)
    res = validate_bundle(root, ENGINE, n=3)
    if not res.get("legal"):
        return JSONResponse({"ok": False, "message": f"Rejected — {str(res.get('error') or 'agent produced no decisive match')[:160]}"}, status_code=422)
    _register(name, owner, sid, root, res)
    JOBS.put(sid)
    return {"ok": True, "id": sid, "status": "queued",
            "message": f"✓ {name} validated — legal, {res['decisive']} smoke matches. Queued to fight champion-dwebble; watch the leaderboard."}
