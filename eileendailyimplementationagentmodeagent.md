# Eileen Daily Implementation Agent Mode Agent

This file is the repo-local runbook for the daily GPT-5.5 Thinking implementation agent. The daily agent prompt must explicitly read this file before editing this repo. This file is intentionally separate from `AGENTS.md`; it is a workflow contract for converting Daily Deep Research Report issues into additive implementation PRs.

## Repository responsibility

`0xHoneyJar/loa-finn` owns deterministic experiments and runtime measurement: preregistered SHA-pinned experiments, no-LLM scoring, runtime audit trails, WAL/event sourcing, sandboxing, cost metering, and agent-commerce forensics.

This repo is not the place for Freeside product behavior, Straylight estate doctrine, Dixie API ownership, Hounfour package schemas, Aleph research-précis doctrine, or Arcturus proof-of-revenue oracle logic.

## Eligible input

Only implement from a Daily Deep Research Report issue or follow-up plan-audit issue/comment that contains:

- `PROPOSED_NEXT_LANE_SEED`
- candidate ID
- repo-fit reasoning
- acceptance criteria
- rollback path
- `VERDICT: ACCEPT_PLAN`

If the candidate lacks `VERDICT: ACCEPT_PLAN`, the agent may perform in-run plan audit only for docs, fixtures, tests, or checkers. Runtime/evaluation semantics require explicit external acceptance.

## Selection rule

Pick at most one candidate per run. Prefer work that improves experiment reproducibility, deterministic scoring evidence, cost/correctness measurement, or falsification coverage.

Priority order:

1. docs-only experiment preregistration
2. fixture-only datasets or traces
3. test-only deterministic coverage
4. checker/validator-only additions
5. default-off measurement helpers

## Additive-only policy

Nothing currently working may stop functioning.

Allowed by default:

- new docs
- new preregistration templates
- new fixtures
- new tests
- new deterministic checkers
- default-off experiment harness helpers

Forbidden without explicit Eileen approval:

- deleting files
- changing scoring semantics by default
- replacing deterministic verdicts with LLM judgment
- changing WAL/runtime behavior by default
- production migrations
- broad refactors
- unrelated dependency upgrades
- secrets or real env changes
- sibling repo mutation
- deployment changes
- auto-merge
- closing source issues

## Finn-specific stop conditions

Stop and return `VERDICT: NEEDS_HUMAN` if the candidate would:

- turn an experiment into a product/economy claim
- alter `HELD`, `FALSIFIED`, or `INSUFFICIENT` semantics
- introduce non-deterministic scoring in the score core
- weaken audit trails, cost metering, sandboxing, or WAL/event evidence
- change runtime behavior without an explicit experiment gate

## Implementation steps

1. Read this file, README/package scripts, and relevant docs near the target surface.
2. Inspect the source issue and confirm `VERDICT: ACCEPT_PLAN`.
3. Check for obvious duplicate open issues/PRs.
4. Write a short plan: selected candidate, implementation class, allowed files, forbidden surfaces, checks, rollback.
5. Create a branch named `daily-impl/YYYY-MM-DD-loa-finn-<candidate>`.
6. Implement exactly one candidate with a minimal diff.
7. Run relevant checks from the repo.
8. Open a draft PR.
9. Add `CODEX AUDIT REQUEST` to the PR body.
10. Comment: `@codex review for additive-only scope violations, deterministic-scoring regressions, accidental runtime behavior changes, failing or missing tests, rollback clarity, repo-boundary violations, and security regressions`.
11. Do not merge and do not close the source issue.

## PR body requirements

The PR must include:

- source issue
- candidate ID
- implementation class
- what changed
- what did not change
- checks run
- skipped or failing checks
- rollback path
- Codex audit request

## Final run report

Report the selected repo, source issue, branch, PR URL, files changed, checks run, Codex review status, blockers, and whether any boundary was approached.
