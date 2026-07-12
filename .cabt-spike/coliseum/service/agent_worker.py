# agent_worker.py — runs ONE untrusted bundle's agent in an isolated subprocess. BINARY JSON-line IPC.
#   read  {"obs": <obs dict>}\n  from fd 0
#   write {"pick": [...]}\n      to the (dup'd) original fd 1
#
# F2 FIX: the bundle dir (cwd) is put on sys.path so `from main import agent` resolves the bundle's
#         main.py + its cabt/ (a bare `python <script>` sets sys.path[0]=the SCRIPT's dir, not cwd —
#         which silently broke every match into floor-vs-floor).
# IPC PROTECTION (F5): dup the real fd 1 for our protocol, then point fd 1 → fd 2 so ANYTHING the
#         bundle prints (stdout) cannot corrupt the channel; the parent sets stderr=DEVNULL.
# Import failure is surfaced as `_import_error` on the first reply (no more silent floor).
import sys, os, json

sys.path.insert(0, os.environ["OUR_CG"])     # our engine (for the agent's internal search)
sys.path.insert(0, os.getcwd())              # F2: the bundle dir → main.py + its cabt/ resolve
os.environ.setdefault("CABT_AUGURY", "prize_only")
os.environ.setdefault("CABT_ROLLOUT", "0")

_OUT = os.fdopen(os.dup(1), "wb", buffering=0)   # the protocol channel (original stdout)
os.dup2(2, 1)                                     # bundle's stdout → stderr (→ DEVNULL); IPC stays clean
_IN = sys.stdin.buffer


def _emit(obj):
    _OUT.write((json.dumps(obj) + "\n").encode())


def floor(sel):
    if not sel:
        return []
    opt = sel.get("option") or []
    if not opt:
        return []
    k = max(1, int(sel.get("minCount", 0) or 0))
    return sorted(range(min(k, len(opt))))


_agent = None
_import_error = None
try:
    from main import agent as _agent          # the bundle's Kaggle entry (its own cabt/)
except Exception as e:
    _import_error = f"{type(e).__name__}: {e}"

_first = True
for raw in _IN:
    raw = raw.strip()
    if not raw:
        continue
    try:
        obs = json.loads(raw).get("obs")
    except Exception:
        _emit({"pick": []}); continue
    sel = (obs or {}).get("select")
    if _agent is None:
        msg = {"pick": floor(sel)}
        if _first and _import_error:
            msg["_import_error"] = _import_error   # surface the failure ONCE (coordinator hard-errors)
        _first = False
        _emit(msg); continue
    _first = False
    try:
        pick = _agent(obs)
    except Exception:
        pick = None
    _emit({"pick": pick if pick else floor(sel)})
