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

## Decision

Use one gateway safety PR because these issues share one root contract: externally reachable gateway behavior and mutation paths must be explicit, bounded, and verifiable.

## Rollback

Rollback is the closing PR revert; implementation commits should keep gateway/admin behavior changes contained.

## Non-claims

This lane does not certify the full Finn runtime and does not close issue references until implementation evidence is present.