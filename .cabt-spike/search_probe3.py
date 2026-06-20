"""Sprint-1 task-1 (cont): bind SearchStep + prove a multi-step forward rollout.
SearchBegin(ubyte*,int)->StartData is CONFIRMED. Now fork-test SearchStep signatures; for the
survivor, run a short forward rollout (SearchStep down a line, parsing each returned state's JSON)
to prove the engine's lookahead is usable for ISMCTS. Then test SearchEnd/SearchRelease. linux/amd64 only.
"""
import json
import os
import random
from ctypes import c_char_p, c_int, c_void_p, c_ubyte, POINTER
from kaggle_environments.envs.cabt.cg import game
from kaggle_environments.envs.cabt.cg.sim import lib, StartData, SerialData
from kaggle_environments.envs.cabt import cabt as cabt_mod


def legal_pick(sel):
    opts = sel.get("option") or []
    k = min(max(sel.get("minCount", 0), 1), sel.get("maxCount", 1), len(opts))
    return random.sample(range(len(opts)), k) if opts else []


# drive to a real decision; capture blob + a legal select
deck = list(cabt_mod.deck)
obs, _ = game.battle_start(deck, deck)
blob, pick = None, None
for step in range(12):
    if obs is None:
        break
    sel = obs.get("select")
    if sel is None:
        break
    if (sel.get("option") and obs.get("search_begin_input") and step >= 1):
        blob = obs["search_begin_input"]
        pick = legal_pick(sel)
        break
    obs = game.battle_select(legal_pick(sel))

assert blob and pick is not None, "no blob/pick"
blob_bytes = blob.encode("ascii")
buf = (c_ubyte * len(blob_bytes))(*blob_bytes)
print("BLOB_LEN", len(blob_bytes), "ROOT_PICK", pick)

# SearchBegin (confirmed signature)
lib.SearchBegin.argtypes = [POINTER(c_ubyte), c_int]
lib.SearchBegin.restype = StartData

# candidate SearchStep signatures: (search_id, int* select, int len) -> ?
STEP_CANDS = [
    ("...-> SerialData", SerialData),
    ("...-> StartData",  StartData),
    ("...-> int",        c_int),
]

for name, rest in STEP_CANDS:
    r_fd, w_fd = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(r_fd)
        try:
            sb = lib.SearchBegin(buf, len(blob_bytes))
            sid = sb.battlePtr
            lib.SearchStep.argtypes = [c_void_p, POINTER(c_int), c_int]
            lib.SearchStep.restype = rest
            arr = (c_int * len(pick))(*pick)
            r = lib.SearchStep(sid, arr, len(pick))
            if rest is SerialData:
                head = r.json[:120].decode(errors="replace") if r.json else None
                os.write(w_fd, ("OK SerialData count=%s json=%r" % (r.count, head)).encode()[:400])
            elif rest is StartData:
                os.write(w_fd, ("OK StartData battlePtr=%s err=%s/%s" % (
                    bool(r.battlePtr), r.errorPlayer, r.errorType)).encode()[:200])
            else:
                os.write(w_fd, ("OK int=%s" % r).encode()[:120])
        except Exception as e:
            os.write(w_fd, ("PYERR %r" % e).encode()[:200])
        os.close(w_fd)
        os._exit(0)
    else:
        os.close(w_fd)
        out = os.read(r_fd, 500).decode(errors="replace")
        os.close(r_fd)
        _, status = os.waitpid(pid, 0)
        print(("SEGV  %-18s signal %d" % (name, os.WTERMSIG(status))) if os.WIFSIGNALED(status)
              else ("LIVE  %-18s %s" % (name, out)))

# rollout with the SerialData signature (in a child, isolated)
r_fd, w_fd = os.pipe()
pid = os.fork()
if pid == 0:
    os.close(r_fd)
    try:
        sb = lib.SearchBegin(buf, len(blob_bytes))
        sid = sb.battlePtr
        lib.SearchStep.argtypes = [c_void_p, POINTER(c_int), c_int]
        lib.SearchStep.restype = SerialData
        lib.SearchEnd.argtypes = [c_void_p]
        lib.SearchRelease.argtypes = [c_void_p]
        lines = []
        cur = pick
        for i in range(4):
            arr = (c_int * len(cur))(*cur)
            sd = lib.SearchStep(sid, arr, len(cur))
            o = json.loads(sd.json.decode()) if sd.json else None
            s = (o or {}).get("select")
            if s is None:
                lines.append("step%d: TERMINAL/no-select (count=%s)" % (i, sd.count))
                break
            lines.append("step%d: type=%s nopts=%s maxC=%s" % (
                i, s.get("type"), len(s.get("option") or []), s.get("maxCount")))
            cur = legal_pick(s)
        lib.SearchEnd(sid)
        lib.SearchRelease(sid)
        os.write(w_fd, ("ROLLOUT_OK " + " | ".join(lines) + " | END+RELEASE ok").encode()[:600])
    except Exception as e:
        os.write(w_fd, ("ROLLOUT_PYERR %r" % e).encode()[:300])
    os.close(w_fd)
    os._exit(0)
else:
    os.close(w_fd)
    out = os.read(r_fd, 700).decode(errors="replace")
    os.close(r_fd)
    _, status = os.waitpid(pid, 0)
    print(("ROLLOUT SEGV signal %d" % os.WTERMSIG(status)) if os.WIFSIGNALED(status)
          else ("ROLLOUT " + out))

print("DONE")
