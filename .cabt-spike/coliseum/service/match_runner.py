# match_runner.py — the authoritative match COORDINATOR (SDD-lite + Sprint 1, R1 symmetric-workers fix).
# The coordinator owns the cg engine (drives battle_start/battle_select) but runs NEITHER agent in its
# process. BOTH the foreign submission AND the champion run as hardened subprocess workers (JSON-line
# IPC); the coordinator brokers each `select` to the worker for current.yourIndex. This symmetry is
# load-bearing: running the champion in-process advantaged it (shared live cg state) and made the
# foreign side lose ~always (mirror 1-11); symmetric workers restore fairness (mirror ≈ 50%).
# Faithful deck-as-first-action protocol: decks pre-given to battle_start; a `select is None` step is
# SKIPPED, never fed to an agent (the GAMES-016 0% bug). Records one game → a cabt-viewer replay.
import json, math, os, select, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.environ.get("OUR_CG", os.path.join(HERE, "engine"))
sys.path.insert(0, ENGINE)                       # cg engine (the coordinator drives the authoritative match)
os.environ.setdefault("CABT_AUGURY", "prize_only")
os.environ.setdefault("CABT_ROLLOUT", "0")
os.environ.setdefault("OUR_CG", ENGINE)

from cg import game                               # noqa: E402
from cg.api import all_card_data, all_attack      # noqa: E402
import sandbox                                     # noqa: E402

CHAMPION_DIR = os.path.join(HERE, "champion")     # the champion bundle (v4 on the Dwebble deck)
CHAMPION_DECK = os.path.join(CHAMPION_DIR, "deck.csv")
CHAMPION_ELO = 1246                                # champion-dwebble standing (coliseum run, GAMES-016)
PER_DECISION_TIMEOUT = float(os.environ.get("DECISION_TIMEOUT", "20"))   # s, per pick
PER_MATCH_WALLCLOCK = float(os.environ.get("MATCH_WALLCLOCK", "180"))    # s, per game
MAX_PICK_BYTES = 1_000_000                                               # F6: cap one IPC reply (anti host-OOM)


def _load_deck(path):
    return [int(l) for l in open(path) if l.strip()]


def to_jsonable(v):
    if hasattr(v, "__dataclass_fields__"):
        return {f: to_jsonable(getattr(v, f)) for f in v.__dataclass_fields__}
    if isinstance(v, dict):
        return {k: to_jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [to_jsonable(x) for x in v]
    return v


class Worker:
    """An agent (foreign OR champion) in a hardened subprocess; one pick per request over JSON-line IPC."""
    def __init__(self, bundle_dir, extra_env=None):
        env = {"OUR_CG": ENGINE}
        if extra_env:
            env.update(extra_env)
        self.bundle_dir = bundle_dir
        self.extra_env = env
        self.p = sandbox.spawn([sys.executable, os.path.join(HERE, "agent_worker.py")], cwd=bundle_dir, extra_env=env)

    def pick(self, raw_obs):
        if self.p.poll() is not None:
            raise RuntimeError("worker exited")
        try:
            self.p.stdin.write((json.dumps({"obs": to_jsonable(raw_obs)}) + "\n").encode())
            self.p.stdin.flush()
        except (BrokenPipeError, OSError):
            raise RuntimeError("worker stdin closed")
        # F3/F6: deadline-bounded read of ONE line via os.read (select-ready ≠ full-line; readline could
        # block past the timeout on a partial line). Byte-capped against a host-OOM flood.
        fd = self.p.stdout.fileno()
        deadline = time.time() + PER_DECISION_TIMEOUT
        buf = bytearray()
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise TimeoutError("agent decision timed out")
            ready, _, _ = select.select([fd], [], [], remaining)
            if not ready:
                raise TimeoutError("agent decision timed out")
            chunk = os.read(fd, 65536)
            if not chunk:
                raise RuntimeError("worker closed stdout")
            buf += chunk
            if len(buf) > MAX_PICK_BYTES:
                raise RuntimeError("worker output exceeded cap")
            nl = buf.find(b"\n")
            if nl != -1:
                obj = json.loads(bytes(buf[:nl]))
                if obj.get("_import_error"):                 # F2: surface, don't silently floor
                    raise RuntimeError(f"bundle import failed: {obj['_import_error']}")
                return obj.get("pick") or []

    def respawn(self):
        sandbox.killpg(self.p)
        self.p = sandbox.spawn([sys.executable, os.path.join(HERE, "agent_worker.py")], cwd=self.bundle_dir, extra_env=self.extra_env)

    def close(self):
        sandbox.killpg(self.p)


def _sanitize_pick(pick, sel):
    """F10: the worker's pick is UNTRUSTED — coerce to in-range option indices (honoring maxCount),
    else a legal floor. Never feed raw agent output to the engine."""
    opt = sel.get("option") or []
    n = len(opt)
    if n == 0:
        return []
    out = []
    if isinstance(pick, list):
        for i in pick:
            if isinstance(i, bool) or not isinstance(i, int):
                continue
            if 0 <= i < n and i not in out:
                out.append(i)
    if not out:
        return [0]
    try:
        maxc = int(sel.get("maxCount", 1))
    except (TypeError, ValueError):
        maxc = 1
    return out[:maxc] if maxc and maxc > 0 else out


def _play(deck0, deck1, worker0, worker1, deadline):
    """One game. worker0 plays seat 0, worker1 plays seat 1. Returns (winning_seat|None, steps).
    Faithful: `select is None` → skip (never ask an agent)."""
    obs, _start = game.battle_start(deck0, deck1)
    steps = []
    try:
        for _ in range(4000):
            if obs is None:
                return None, steps
            if time.time() > deadline:
                raise TimeoutError("match wall-clock exceeded")
            cur, sel = obs.get("current"), obs.get("select")
            if cur is not None and cur.get("result", -1) != -1:
                steps.append({"index": len(steps), "observation": to_jsonable(obs), "action": []})
                return cur.get("result"), steps
            if sel is None:
                return None, steps
            you = cur["yourIndex"] if cur is not None else 0
            raw_pick = (worker0 if you == 0 else worker1).pick(obs)
            pick = _sanitize_pick(raw_pick, sel)             # F10: never trust the agent's output shape
            steps.append({"index": len(steps), "observation": to_jsonable(obs), "action": pick})
            obs = game.battle_select(pick)
        return None, steps
    finally:
        game.battle_finish()


def _provisional_elo(wins, n):
    p = (wins + 0.5) / (n + 1)
    p = min(max(p, 1e-3), 1 - 1e-3)
    return round(CHAMPION_ELO + 400 * math.log10(p / (1 - p)))


def run_champion_match(bundle_dir, foreign_deck_path, n_per_seat=4):
    """Play the submission vs the champion, seat-swapped, BOTH as subprocess workers. Returns
    (result dict, replay dict|None)."""
    foreign_deck = _load_deck(foreign_deck_path)
    champ_deck = _load_deck(CHAMPION_DECK)
    for d in (bundle_dir, CHAMPION_DIR):
        try:
            os.chmod(d, 0o755)
        except OSError:
            pass
    foreign = Worker(bundle_dir)
    champion = Worker(CHAMPION_DIR)
    wins = decisive = 0
    errors = []
    replay_steps = replay_meta = None
    try:
        for i in range(n_per_seat * 2):
            deadline = time.time() + PER_MATCH_WALLCLOCK
            foreign_seat = 0 if i % 2 == 0 else 1
            if foreign_seat == 0:
                d0, d1, w0, w1 = foreign_deck, champ_deck, foreign, champion
            else:
                d0, d1, w0, w1 = champ_deck, foreign_deck, champion, foreign
            try:
                result, steps = _play(d0, d1, w0, w1, deadline)
            except (TimeoutError, RuntimeError) as e:
                result, steps = None, []
                errors.append(str(e))
                foreign.respawn(); champion.respawn()   # F7: a hung-but-alive worker is desynced — always respawn
            if result is None:
                continue
            decisive += 1
            won = (result == foreign_seat)
            wins += 1 if won else 0
            if replay_steps is None:
                replay_steps = steps
                replay_meta = {"foreign_seat": foreign_seat, "result_seat": result, "won": won}
    finally:
        foreign.close()
        champion.close()
    elo = _provisional_elo(wins, decisive) if decisive else None
    replay = _assemble_replay(replay_steps, replay_meta) if replay_steps else None
    return {"wins": wins, "losses": decisive - wins, "decisive": decisive,
            "winPct": round(wins / decisive, 3) if decisive else 0.0, "elo": elo,
            "errors": errors}, replay


def _assemble_replay(steps, meta):
    vis = [{"select": s["observation"].get("select"), "logs": s["observation"].get("logs"),
            "current": s["observation"].get("current"), "selected": s["action"]} for s in steps]
    return {
        "ok": True,
        "cards": [to_jsonable(c) for c in all_card_data()],
        "attacks": [to_jsonable(a) for a in all_attack()],
        "steps": steps,
        "visualize": vis,
        "_coliseum": {"vs": "champion-dwebble", **(meta or {})},
    }
