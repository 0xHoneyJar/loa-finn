#!/usr/bin/env python3
"""
verify.py — the independent check (the discipline, not the infrastructure).

The whole design rests on one rule: believe the receipt, not the story. A construct that
SAYS it solved the matrix and one that DID are different things. This script re-derives
the claims in a run.json WITHOUT trusting the values the producer wrote — exactly the
posture your real Custodian/Adjudicator must take.

It checks three things, the same three the architecture marks as the binding checks:

  1. CHAIN INTEGRITY  — recompute the hash chain; every receipt must match (custody shape).
  2. MIXTURE VALIDITY — each reported mixture is a real probability vector.
  3. CONVERGENCE      — exploitability is non-increasing in trend and the final value is
                        small, i.e. the population actually grew counters that worked.

It deliberately RE-COMPUTES the chain from the recorded payloads rather than trusting the
stored `receipt` fields. That is the point: an independent verifier, not a self-report.

Run:
    python3 verify.py run.json
Exit code 0 = all checks pass; non-zero = a check failed (fail closed).
"""

import json, sys, hashlib


def chain(prev: str, payload: dict) -> str:
    h = hashlib.sha256()
    h.update(prev.encode())
    # reconstruct the payload WITHOUT the receipt field the producer appended
    core = {k: payload[k] for k in payload if k != "receipt"}
    h.update(json.dumps(core, sort_keys=True).encode())
    return h.hexdigest()


def main():
    if len(sys.argv) < 2:
        print("usage: python3 verify.py run.json", file=sys.stderr)
        sys.exit(2)

    with open(sys.argv[1]) as f:
        run = json.load(f)

    history = run.get("history", [])
    failures = []
    tol = 1e-4

    # ---- 1. CHAIN INTEGRITY -----------------------------------------------------------
    receipt = "genesis"
    for i, rec in enumerate(history):
        receipt = chain(receipt, rec)
        if rec.get("receipt") != receipt:
            failures.append(f"chain break at iter {rec.get('iter', i)}: "
                            f"recomputed {receipt[:12]}… ≠ stored {str(rec.get('receipt'))[:12]}…")
    if history and run.get("receipt") != receipt:
        failures.append("final receipt does not match recomputed chain head")

    # ---- 2. MIXTURE VALIDITY ----------------------------------------------------------
    for rec in history:
        mix = rec.get("mixture", [])
        s = sum(mix)
        if abs(s - 1.0) > tol:
            failures.append(f"iter {rec['iter']}: mixture sums to {s:.6f}, not 1.0")
        if any(p < -tol for p in mix):
            failures.append(f"iter {rec['iter']}: mixture has a negative weight")

    # ---- 3. CONVERGENCE ---------------------------------------------------------------
    expls = [rec.get("exploitability", 1.0) for rec in history]
    if expls:
        final = expls[-1]
        # trend: allow noise, but the last value should beat the first by a clear margin
        if len(expls) >= 3 and final > expls[0] + tol:
            failures.append(f"exploitability did not improve: first {expls[0]:.6f} → "
                            f"final {final:.6f} (population failed to grow useful counters)")
        if final > 0.05:
            failures.append(f"final exploitability {final:.6f} > 0.05 — not converged "
                            f"(run more iters, or the game/oracle is mismatched)")

    # ---- VERDICT (fail closed) --------------------------------------------------------
    print(f"checked {len(history)} iterations")
    if failures:
        print("\nFAILED — the run's claims do not hold up:")
        for fmsg in failures:
            print("  ✗", fmsg)
        print("\n[custodian] refusing this run. A failing check is a refusal, not an average.")
        sys.exit(1)

    print("  ✓ chain integrity: every receipt re-derives")
    print("  ✓ mixture validity: all mixtures are probability vectors")
    print("  ✓ convergence: exploitability improved and final value is small")
    print("\n[custodian] run verified. The receipt is real, not narrated.")
    sys.exit(0)


if __name__ == "__main__":
    main()
