# Eileen Daily Implementation Agent Mode Agent

This is the repo-local runbook for the daily GPT-5.5 Thinking implementation agent. The daily agent prompt must explicitly read this file before editing this repo. The agent must first explain what should be implemented, why it matters, why it fits this repo, how it advances the repo endgame, and how the implementation remains safe at scale.

## Repository responsibility

`0xHoneyJar/loa-finn` owns deterministic experiments and runtime measurement: preregistered SHA-pinned experiments, no-LLM scoring, runtime audit trails, WAL/event sourcing, sandboxing, cost metering, and agent-commerce forensics.

This repo is not the place for Freeside product behavior, Straylight estate doctrine, Dixie API ownership, Hounfour package schemas, Aleph research-précis doctrine, or Arcturus proof-of-revenue oracle logic.

## Eligible input

Only implement from a Daily Deep Research Report issue or follow-up plan-audit item with `PROPOSED_NEXT_LANE_SEED`, candidate ID, repo-fit reasoning, acceptance criteria, rollback path, and `VERDICT: ACCEPT_PLAN`.

Without `VERDICT: ACCEPT_PLAN`, the agent may self-audit only docs, fixtures, tests, or checkers. Runtime/evaluation semantics require explicit external acceptance.

## Mandatory pre-implementation thesis

Before editing, write this in the run log and later carry it into the PR body:

1. Candidate chosen: issue, candidate ID, and verdict.
2. What should be implemented: precise change, not a vague theme.
3. Why this should be implemented now: source evidence plus current repo state.
4. Why this belongs in `loa-finn`: repo-fit and why sibling repos should not own it.
5. What this is good for: reproducibility, falsification, cost/correctness evidence, or runtime audit quality.
6. Why this approach should work: deterministic mechanism, expected evidence, and proof path.
7. Endgame contribution: how this moves Finn toward a better agent-commerce experiment and runtime truth substrate.
8. Creative/innovative extension path: future lanes after this PR, clearly marked as future work.
9. Mass-user scaling impact: experiment volume, data size, runtime cost, WAL growth, sandbox load, and measurement overhead.
10. Security scope: sandbox boundaries, trace integrity, prompt/model isolation, cost abuse, and evidence tampering risks.
11. Simplification / exploit-prevention argument: how the change avoids non-determinism and fragile hidden behavior.
12. Non-goals and forbidden surfaces.
13. Tests/checks and rollback path.

If the agent cannot complete this thesis convincingly, it must not implement.

## Additive-only policy

Nothing currently working may stop functioning.

Allowed by default: new docs, preregistration templates, fixtures, tests, deterministic checkers, and default-off experiment harness helpers.

Forbidden without explicit Eileen approval: deleting files, changing scoring semantics by default, replacing deterministic verdicts with LLM judgment, changing WAL/runtime behavior by default, production migrations, broad refactors, unrelated dependency upgrades, secrets or real env changes, sibling repo mutation, deployment changes, auto-merge, or closing source issues.

## Finn-specific stop conditions

Stop and return `VERDICT: NEEDS_HUMAN` if the candidate would turn an experiment into a product/economy claim, alter `HELD`, `FALSIFIED`, or `INSUFFICIENT` semantics, introduce non-deterministic scoring in the score core, weaken audit trails/cost metering/sandboxing/WAL evidence, or change runtime behavior without an explicit experiment gate.

## Implementation steps

1. Read this file, README/package scripts, and relevant docs near the target surface.
2. Confirm the source item has `VERDICT: ACCEPT_PLAN`.
3. Check for obvious duplicate open issues/PRs.
4. Write the mandatory pre-implementation thesis.
5. Create a branch named `daily-impl/YYYY-MM-DD-loa-finn-<candidate>`.
6. Implement exactly one candidate with a minimal diff.
7. Prefer simpler deterministic logic and explicit checks over clever abstractions.
8. Run relevant checks.
9. Open a draft PR.
10. Add `CODEX AUDIT REQUEST` and the required traceability report.
11. Comment: `@codex review for additive-only scope violations, deterministic-scoring regressions, accidental runtime behavior changes, scaling risks, security regressions, exploit-prone complexity, failing or missing tests, rollback clarity, and repo-boundary violations`.
12. Do not merge and do not close the source issue.

## Required PR traceability report

Every implementation PR must include source issue and candidate ID, pre-implementation thesis summary, what changed with file-by-file rationale, why each changed file is good for this repo, why it advances the repo endgame, why it should work, mass-user scaling analysis, security scope and exploit-prevention analysis, simplicity analysis, tests/checks, skipped checks, rollback path, future creative/innovative solution paths not implemented, and `CODEX AUDIT REQUEST`.

## Final run report

Report selected repo, source issue, branch, PR URL, files changed, checks run, Codex review status, blockers, and boundaries approached.
