# Audit lane: Gateway guard, admin mutation, ownership, and public URL safety

## Purpose

This draft PR distills Finn's gateway guard, admin mutation, credit input, wallet validation, conversation ownership, route policy, and public URL issues into one implementation lane. It is a routing artifact and does not claim the fixes are complete yet.

## Issue coverage

Refs #198, #199, #200, #201, #202, #203, #204, #206, #208, #209, #210, #213, #214, #215, #216, #217, #219, #221, #223, #224, #225, #226, #228, #229, #230, #231, #233, #234, #236.

## Preserved state

Preserve current Finn runtime behavior outside the named gateway, admin, ownership, and public URL safety surfaces.

## Target

Make gateway route guards, admin mutations, credit inputs, wallet normalization, conversation ownership preconditions, route policy evidence, and public URL generation explicit and testable.

## Expected artifacts

Likely scope includes `src/gateway/server.ts`, `src/gateway/routes/admin.ts`, `src/gateway/routes/conversations.ts`, `src/nft/conversation.ts`, route policy tests, admin tests, ownership tests, and public URL config docs.

## Allowed scope

Allowed: focused gateway/runtime code, tests, fixtures, and docs. Not allowed: unrelated package metadata, compatibility matrix, or full validation script work owned by the companion runtime-evidence lane.

## Implemented sub-scope in this PR

The current implementation evidence is intentionally narrower than the full lane title:

- admin `seed-credits` wallet-shape validation and lowercase normalization;
- safe-integer credit bounds for `seed-credits`, including the documented `0..1_000_000` inclusive operator/CI cap;
- admin route tests for mixed-case EVM input, malformed wallets, zero credit seed, exact maximum seed, fractional seed, and over-limit seed;
- Finn-only E2E harness alignment so Freeside/Dixie checks are not implied unless the relevant service URLs are configured;
- a seed-credit operator policy document at `docs/gateway-admin-seed-credits-policy.md`.

This sub-scope does not complete the full gateway/admin/ownership/public-URL lane.

## Cross-lane dependency note

The DB-init and E2E harness changes overlap with the runtime-evidence lane, but they are kept here because the gateway/admin safety tests depend on deterministic Finn-only setup:

- migrations should own application schema creation instead of relying on Docker init pre-creation;
- Finn-only CI should not fail because unrelated Freeside/Dixie URLs are absent;
- full three-service E2E remains a separate configured evidence path, not silently removed from the product contract.

## Remaining lane work before broad acceptance

The following items remain outside the connector-safe patch completed here and should not be considered closed by this PR:

- Host-derived/public URL generation policy and tests;
- conversation ownership enforcement and negative tests;
- route skip/guard matrix generation and drift detection;
- multi-instance/distributed admin rate-limiting semantics;
- dependency-audit remediation requiring package graph plus `pnpm-lock.yaml` regeneration;
- long legacy E2E artifact classification/reproduction.

## Decision

Use one gateway safety PR because these issues share one root contract: externally reachable gateway behavior and mutation paths must be explicit, bounded, and verifiable.

## Rollback

Rollback is the closing PR revert; implementation commits should keep gateway/admin behavior changes contained.

## Non-claims

This lane does not certify the full Finn runtime and does not close issue references until implementation evidence is present.