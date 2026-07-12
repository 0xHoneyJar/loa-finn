# sandbox.py — hardened subprocess for running UNTRUSTED teammate agent code (SDD-lite Decision 1).
# Railway's managed PaaS can't do container-per-match / gVisor / nsjail (no privilege), so we layer
# defense-in-depth at spawn time: SCRUBBED ENV (fixes the live os.environ leak) + setrlimit caps +
# privilege-drop to nobody (the image runs as root) + setsid (so killpg reaches the whole subtree).
# Sprint 1 lands this shape; Sprint 3 adds the seccomp net-block + rlimit tuning + adversarial tests.
import os, resource, signal, subprocess, sys

NOBODY_UID = int(os.environ.get("WORKER_UID", "65534"))   # 'nobody' in python:3.12/Debian
NOBODY_GID = int(os.environ.get("WORKER_GID", "65534"))

# Only these pass through to untrusted code — NOT {**os.environ} (which leaked every Railway secret).
SCRUB_KEEP = ("PATH", "LANG", "LC_ALL", "TMPDIR", "OUR_CG", "CABT_AUGURY", "CABT_ROLLOUT", "SMOKE_N")

# Resource caps: generous enough for a heuristic-class full match, lethal to the pathological.
# (Wall-clock timeout in the coordinator is the PRIMARY hang guard; these are the resource backstop.)
_RLIM = {
    resource.RLIMIT_CPU:    (180, 180),                       # cumulative CPU seconds
    resource.RLIMIT_AS:     (2 * 1024**3, 2 * 1024**3),       # 2 GB address space — memory bomb
    resource.RLIMIT_NPROC:  (96, 96),                         # fork bomb
    resource.RLIMIT_FSIZE:  (16 * 1024**2, 16 * 1024**2),     # 16 MB max single write — disk fill
    resource.RLIMIT_NOFILE: (256, 256),
}


def scrubbed_env(extra: dict | None = None) -> dict:
    env = {k: os.environ[k] for k in SCRUB_KEEP if k in os.environ}
    env.setdefault("TMPDIR", "/tmp")
    if extra:
        env.update(extra)
    return env


def harden() -> None:
    """preexec_fn — runs in the child AFTER fork, BEFORE exec. New session + rlimits + drop root."""
    os.setsid()                                              # own pgid → killpg(getpgid) kills the subtree
    for res, lim in _RLIM.items():
        try:
            resource.setrlimit(res, lim)
        except (ValueError, OSError):
            pass
    if os.geteuid() == 0:                                    # drop root only if we have it (Railway image)
        try:
            os.setgroups([])
            os.setgid(NOBODY_GID)
            os.setuid(NOBODY_UID)                            # MUST be the last privileged op
        except OSError:
            pass
    # Sprint 3: install_seccomp_net_block()  # PR_SET_NO_NEW_PRIVS + deny socket/connect/socketcall


def spawn(argv, cwd, extra_env=None) -> subprocess.Popen:
    """Spawn a hardened child with BINARY pipes (for deadline-bounded os.read IPC) and stderr→DEVNULL
    (F5: an unread stderr PIPE deadlocks a chatty/hostile agent; we never consume it)."""
    return subprocess.Popen(
        argv, cwd=cwd, env=scrubbed_env(extra_env),
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        bufsize=0, preexec_fn=harden,
    )


def killpg(p: subprocess.Popen) -> None:
    """SIGKILL the whole process group, then REAP (no zombies, F4) and CLOSE pipes (no FD leak, F4)."""
    try:
        os.killpg(os.getpgid(p.pid), signal.SIGKILL)
    except (ProcessLookupError, OSError):
        try:
            p.kill()
        except OSError:
            pass
    try:
        p.wait(timeout=5)
    except Exception:
        pass
    for stream in (p.stdin, p.stdout, p.stderr):
        try:
            if stream:
                stream.close()
        except Exception:
            pass
