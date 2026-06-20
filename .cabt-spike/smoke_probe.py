"""Phase-0 cabt smoke + ABI probe. Runs ONLY in linux/amd64 (libcg.so is a Linux ELF).
Proves: make('cabt') loads, a full random-vs-random match runs, the -1/0/1 settle exists,
captures a golden obs fixture, and confirms the SearchBegin/Step/End ctypes symbols are callable.
"""
import json
from kaggle_environments import make
from kaggle_environments.envs.cabt import cabt as cabt_mod


def main():
    env = make("cabt", debug=True)
    print("MAKE_OK name=%s agents=%s" % (env.name, env.configuration.get("agents") if hasattr(env, "configuration") else "?"))

    env.run([cabt_mod.random_agent, cabt_mod.random_agent])
    final = env.state
    print("MATCH_DONE rewards=%s statuses=%s steps=%d" % (
        [s.reward for s in final], [s.status for s in final], len(env.steps)))

    # golden fixture: first real (non-deck) observation with a select
    fixture = None
    for step in env.steps:
        for ag in step:
            o = ag.observation
            if o and isinstance(o, dict) and o.get("select") is not None:
                sel = o.get("select")
                fixture = {
                    "obs_keys": sorted(o.keys()),
                    "select_type": type(sel).__name__,
                    "select_keys": sorted(sel.keys()) if isinstance(sel, dict) else None,
                    "select_sample": str(sel)[:800],
                }
                break
        if fixture:
            break
    print("OBS_FIXTURE", json.dumps(fixture, default=str)[:2000])

    # search-API + core symbols callable via ctypes?
    from kaggle_environments.envs.cabt.cg.sim import lib
    syms = {s: hasattr(lib, s) for s in
            ["SearchBegin", "SearchStep", "SearchEnd", "SearchRelease", "GetBattleData", "Select", "BattleStart"]}
    print("SYMS", json.dumps(syms))


if __name__ == "__main__":
    main()
