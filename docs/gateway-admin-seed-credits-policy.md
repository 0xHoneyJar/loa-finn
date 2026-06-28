# Finn Admin Seed Credits Policy

This document scopes the admin `seed-credits` behavior hardened in PR #238.

## Endpoint

`POST /api/v1/admin/seed-credits`

## Authentication

The endpoint remains guarded by `FINN_AUTH_TOKEN`. If the token is not configured, the endpoint is disabled and returns `503`.

## Wallet input

The request `wallet_address` must be a 0x-prefixed 20-byte EVM address:

- accepted shape: `0x` followed by exactly 40 hex characters;
- mixed case is accepted at the input boundary;
- stored/returned value is normalized to lowercase;
- missing prefix, short address, long address, or non-hex characters are rejected.

This endpoint is EVM-only. Support for other chain/address families must be added as an explicit future change with separate validation rules.

## Credit input

`credits` must be a safe integer between `0` and `1_000_000`, inclusive.

- `0` is accepted for idempotent reset-to-zero test setup.
- `1_000_000` is the current maximum seed amount for CI/operator test support.
- fractional, negative, non-finite, and over-limit values are rejected.

## Non-claims

This policy does not solve multi-replica admin rate limiting, admin operation audit storage, route guard generation, public URL generation, or conversation ownership enforcement. Those remain follow-up items in the gateway safety lane.
