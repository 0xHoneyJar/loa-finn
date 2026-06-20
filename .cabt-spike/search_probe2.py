"""Sprint-1 task-1: bind SearchBegin's ctypes signature SAFELY by fork-per-candidate.
A wrong argtype/arity segfaults — so each candidate runs in an os.fork() child; a SIGSEGV kills
the child only, and the parent reports it. A CORRECT signature returns a handle whose GetBattleData
yields sane JSON (a real reconstructed game state). Runs ONLY in linux/amd64.
"""
import os
import random
from ctypes import c_char_p, c_int, c_void_p, c_ubyte, POINTER
from kaggle_environments.envs.cabt.cg import game
from kaggle_environments.envs.cabt.cg.sim import lib, Battle, StartData, SerialData
from kaggle_environments.envs.cabt import cabt as cabt_mod


# 1) drive to a real decision, capture the state blob
deck = list(cabt_mod.deck)
obs, _ = game.battle_start(deck, deck)
blob = None
for step in range(12):
    if obs is None:
        break
    sel = obs.get("select")
    if sel is None:
        break
    opts = sel.get("option") or []
    if opts and obs.get("search_begin_input") and step >= 1:
        blob = obs["search_begin_input"]
        break
    k = min(max(sel.get("minCount", 0), 1), sel.get("maxCount", 1), len(opts))
    obs = game.battle_select(random.sample(range(len(opts)), k))

assert blob, "no blob captured"
blob_bytes = blob.encode("ascii")
print("BLOB_LEN", len(blob_bytes))

# 2) candidate SearchBegin signatures
CANDS = [
    ("char_p -> void_p",        [c_char_p],                 c_void_p),
    ("char_p -> StartData",     [c_char_p],                 StartData),
    ("char_p,int -> StartData", [c_char_p, c_int],          StartData),
    ("ubyte*,int -> StartData", [POINTER(c_ubyte), c_int],  StartData),
    ("char_p -> SerialData",    [c_char_p],                 SerialData),
    ("char_p -> int",           [c_char_p],                 c_int),
]


def call(argt, rest):
    lib.SearchBegin.argtypes = argt
    lib.SearchBegin.restype = rest
    if argt == [c_char_p]:
        return lib.SearchBegin(blob_bytes)
    if argt == [c_char_p, c_int]:
        return lib.SearchBegin(blob_bytes, len(blob_bytes))
    buf = (c_ubyte * len(blob_bytes))(*blob_bytes)
    return lib.SearchBegin(buf, len(blob_bytes))


def validate_ptr(ptr):
    """If ptr is a real battle/search context, GetBattleData(ptr) returns sane JSON."""
    if not ptr:
        return "null-ptr"
    lib.GetBattleData.restype = SerialData
    lib.GetBattleData.argtypes = [c_void_p]
    sd = lib.GetBattleData(ptr)
    head = sd.json[:90].decode(errors="replace") if sd.json else None
    return "GetBattleData.json=%r count=%s" % (head, sd.count)


for name, argt, rest in CANDS:
    r_fd, w_fd = os.pipe()
    pid = os.fork()
    if pid == 0:  # child
        os.close(r_fd)
        try:
            r = call(argt, rest)
            if rest is c_void_p:
                msg = "ptr=%s | %s" % (bool(r), validate_ptr(r))
            elif rest is StartData:
                msg = "battlePtr=%s err=%s/%s | %s" % (
                    bool(r.battlePtr), r.errorPlayer, r.errorType, validate_ptr(r.battlePtr))
            elif rest is SerialData:
                msg = "SerialData.count=%s json=%r" % (
                    r.count, (r.json[:90].decode(errors="replace") if r.json else None))
            else:
                msg = "int=%s" % r
            os.write(w_fd, ("OK " + msg).encode()[:400])
        except Exception as e:
            os.write(w_fd, ("PYERR %r" % e).encode()[:200])
        os.close(w_fd)
        os._exit(0)
    else:  # parent
        os.close(w_fd)
        out = os.read(r_fd, 500).decode(errors="replace")
        os.close(r_fd)
        _, status = os.waitpid(pid, 0)
        if os.WIFSIGNALED(status):
            print("SEGV  %-26s killed by signal %d  (wrong signature)" % (name, os.WTERMSIG(status)))
        else:
            print("LIVE  %-26s %s" % (name, out))

print("DONE")
