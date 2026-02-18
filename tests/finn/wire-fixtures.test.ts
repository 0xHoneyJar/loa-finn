/**
 * Golden Wire Fixture Tests — Sprint 1 Task 1.1
 *
 * These fixtures capture the v5.0.0 wire format. They MUST pass
 * after the v7.0.0 bump to prove wire compatibility is preserved.
 *
 * Comparison rules (per canonicalization contract):
 * - JSON bodies: byte-for-byte via json-stable-stringify
 * - JWT claims: byte-for-byte on canonicalized claims JSON
 * - JWT signed token: structural equivalence only (ES256 non-deterministic)
 *
 * Fixture update policy: Any change requires schema-audit justification,
 * reviewer sign-off, and arrakis compatibility assessment.
 */
import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import stringify from 'json-stable-stringify';
import {
  parseMicroUSD,
  serializeMicroUSD,
  parseAccountId,
  serializeAccountId,
  parsePoolId,
} from '../../src/hounfour/wire-boundary.js';

// Import schemas from current loa-hounfour (v7.0.0)
import {
  JwtClaimsSchema,
  S2SJwtClaimsSchema,
  UsageReportSchema,
  InvokeResponseSchema,
  StreamStartSchema,
  StreamChunkSchema,
  StreamUsageSchema,
  StreamEndSchema,
  StreamErrorSchema,
  CONTRACT_VERSION,
} from '@0xhoneyjar/loa-hounfour';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/wire');
const KEYS_DIR = path.resolve(__dirname, '../fixtures/keys');

function loadFixture<T>(name: string): T {
  const raw = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf-8');
  return JSON.parse(raw) as T;
}

/** Canonical JSON for byte-for-byte comparison */
function canonical(obj: unknown): string {
  return stringify(obj) as string;
}

/** Verify a fixture is in canonical form (keys already sorted) */
function assertCanonicalForm(fixturePath: string): void {
  const raw = fs.readFileSync(path.join(FIXTURE_DIR, fixturePath), 'utf-8');
  const parsed = JSON.parse(raw);
  const recanonical = JSON.stringify(parsed, null, 2);
  // The fixture on disk should already be in sorted-key JSON format
  // We verify by round-tripping through parse/stringify with sorted keys
  const sortedKeys = JSON.parse(canonical(parsed));
  const resorted = JSON.stringify(sortedKeys, null, 2);
  expect(recanonical).toBe(resorted);
}

// ---------------------------------------------------------------------------
// JWT Claims Fixture
// ---------------------------------------------------------------------------

describe('Golden Wire Fixtures — JWT Claims', () => {
  const fixture = loadFixture<Record<string, unknown>>('jwt-claims.fixture.json');

  it('validates against JwtClaimsSchema', () => {
    // Strip null optional fields for validation (TypeBox Optional doesn't accept null)
    const claims = { ...fixture };
    for (const [k, v] of Object.entries(claims)) {
      if (v === null) delete claims[k];
    }
    const errors = [...Value.Errors(JwtClaimsSchema, claims)];
    expect(errors).toEqual([]);
  });

  it('has deterministic timestamps', () => {
    expect(fixture.iat).toBe(1700000000);
    expect(fixture.exp).toBe(1700003600);
  });

  it('has deterministic nonce', () => {
    expect(fixture.jti).toBe('test-jti-fixture-001');
  });

  it('has valid req_hash format', () => {
    expect(fixture.req_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('round-trips through canonical JSON identically', () => {
    const first = canonical(fixture);
    const second = canonical(JSON.parse(first));
    expect(first).toBe(second);
  });

  it('fixture file is in canonical key order', () => {
    assertCanonicalForm('jwt-claims.fixture.json');
  });
});

// ---------------------------------------------------------------------------
// Billing Request Fixture (UsageReport schema)
// ---------------------------------------------------------------------------

describe('Golden Wire Fixtures — Billing Request', () => {
  const fixture = loadFixture<Record<string, unknown>>('billing-request.fixture.json');

  it('validates against UsageReportSchema', () => {
    const report = { ...fixture };
    for (const [k, v] of Object.entries(report)) {
      if (v === null) delete report[k];
    }
    const errors = [...Value.Errors(UsageReportSchema, report)];
    expect(errors).toEqual([]);
  });

  it('has billing_entry_id', () => {
    expect(fixture.billing_entry_id).toBeDefined();
    expect(typeof fixture.billing_entry_id).toBe('string');
  });

  it('has billing_method', () => {
    expect(['provider_reported', 'observed_chunks_overcount', 'prompt_only']).toContain(
      fixture.billing_method,
    );
  });

  it('contract_version matches current', () => {
    expect(fixture.contract_version).toBe(CONTRACT_VERSION);
  });

  it('round-trips through canonical JSON identically', () => {
    const first = canonical(fixture);
    const second = canonical(JSON.parse(first));
    expect(first).toBe(second);
  });

  it('fixture file is in canonical key order', () => {
    assertCanonicalForm('billing-request.fixture.json');
  });
});

// ---------------------------------------------------------------------------
// Billing Response Fixture (InvokeResponse schema)
// ---------------------------------------------------------------------------

describe('Golden Wire Fixtures — Billing Response', () => {
  const fixture = loadFixture<Record<string, unknown>>('billing-response.fixture.json');

  it('validates against InvokeResponseSchema', () => {
    const response = { ...fixture };
    for (const [k, v] of Object.entries(response)) {
      if (v === null) delete response[k];
    }
    const errors = [...Value.Errors(InvokeResponseSchema, response)];
    expect(errors).toEqual([]);
  });

  it('has billing_entry_id', () => {
    expect(fixture.billing_entry_id).toBeDefined();
    expect(typeof fixture.billing_entry_id).toBe('string');
  });

  it('has billing_method', () => {
    expect(['provider_reported', 'observed_chunks_overcount', 'prompt_only']).toContain(
      fixture.billing_method,
    );
  });

  it('round-trips through canonical JSON identically', () => {
    const first = canonical(fixture);
    const second = canonical(JSON.parse(first));
    expect(first).toBe(second);
  });

  it('fixture file is in canonical key order', () => {
    assertCanonicalForm('billing-response.fixture.json');
  });
});

// ---------------------------------------------------------------------------
// Stream Event Fixtures
// ---------------------------------------------------------------------------

describe('Golden Wire Fixtures — Stream Events', () => {
  const fixtures = loadFixture<Record<string, Record<string, unknown>>>('stream-event.fixture.json');

  it('stream_start validates against StreamStartSchema', () => {
    const errors = [...Value.Errors(StreamStartSchema, fixtures.stream_start)];
    expect(errors).toEqual([]);
  });

  it('chunk validates against StreamChunkSchema', () => {
    const errors = [...Value.Errors(StreamChunkSchema, fixtures.chunk)];
    expect(errors).toEqual([]);
  });

  it('usage validates against StreamUsageSchema', () => {
    const errors = [...Value.Errors(StreamUsageSchema, fixtures.usage)];
    expect(errors).toEqual([]);
  });

  it('stream_end validates against StreamEndSchema', () => {
    const errors = [...Value.Errors(StreamEndSchema, fixtures.stream_end)];
    expect(errors).toEqual([]);
  });

  it('error validates against StreamErrorSchema', () => {
    const errors = [...Value.Errors(StreamErrorSchema, fixtures.error)];
    expect(errors).toEqual([]);
  });

  it('stream_end cost_micro is string-encoded', () => {
    expect(fixtures.stream_end.cost_micro).toMatch(/^[0-9]+$/);
  });

  it('each event round-trips through canonical JSON identically', () => {
    for (const [name, event] of Object.entries(fixtures)) {
      const first = canonical(event);
      const second = canonical(JSON.parse(first));
      expect(first).toBe(second);
    }
  });

  it('fixture file is in canonical key order', () => {
    assertCanonicalForm('stream-event.fixture.json');
  });
});

// ---------------------------------------------------------------------------
// ES256 Keypair
// ---------------------------------------------------------------------------

describe('Golden Wire Fixtures — ES256 Test Keypair', () => {
  it('private key file exists and is PEM format', () => {
    const keyPath = path.join(KEYS_DIR, 'es256-test.key');
    expect(fs.existsSync(keyPath)).toBe(true);
    const key = fs.readFileSync(keyPath, 'utf-8');
    expect(key).toContain('BEGIN EC PRIVATE KEY');
  });

  it('public key file exists and is PEM format', () => {
    const pubPath = path.join(KEYS_DIR, 'es256-test.pub');
    expect(fs.existsSync(pubPath)).toBe(true);
    const pub = fs.readFileSync(pubPath, 'utf-8');
    expect(pub).toContain('BEGIN PUBLIC KEY');
  });

  it('keypair can sign and verify', () => {
    const privKey = fs.readFileSync(path.join(KEYS_DIR, 'es256-test.key'), 'utf-8');
    const pubKey = fs.readFileSync(path.join(KEYS_DIR, 'es256-test.pub'), 'utf-8');

    const data = Buffer.from('test-payload');
    const sign = crypto.createSign('SHA256');
    sign.update(data);
    const signature = sign.sign(privKey);

    const verify = crypto.createVerify('SHA256');
    verify.update(data);
    expect(verify.verify(pubKey, signature)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// JWT Sign + Verify (structural equivalence, NOT byte-for-byte)
// ---------------------------------------------------------------------------

describe('Golden Wire Fixtures — JWT Structural Verification', () => {
  it('JWT claims can be signed with ES256 and verified structurally', async () => {
    const fixture = loadFixture<Record<string, unknown>>('jwt-claims.fixture.json');
    const claims = { ...fixture };
    // Remove null optional fields
    for (const [k, v] of Object.entries(claims)) {
      if (v === null) delete claims[k];
    }

    // Create JWS header
    const header = { alg: 'ES256', typ: 'JWT', kid: 'test-kid-001' };
    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadB64 = Buffer.from(canonical(claims)).toString('base64url');
    const signingInput = `${headerB64}.${payloadB64}`;

    // Sign with test key
    const privKey = fs.readFileSync(path.join(KEYS_DIR, 'es256-test.key'), 'utf-8');
    const sign = crypto.createSign('SHA256');
    sign.update(signingInput);
    const signatureDer = sign.sign(privKey);

    // Convert DER to raw r||s format for JWS
    // ES256 uses P-256 which has 32-byte r and s values
    const signatureB64 = signatureDer.toString('base64url');
    const jwt = `${signingInput}.${signatureB64}`;

    // Verify structure: decode header, compare claims
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);

    const decodedHeader = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    expect(decodedHeader.alg).toBe('ES256');
    expect(decodedHeader.typ).toBe('JWT');
    expect(decodedHeader.kid).toBe('test-kid-001');

    const decodedPayload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    // Claims compared byte-for-byte on canonical form
    expect(canonical(decodedPayload)).toBe(canonical(claims));

    // Verify signature separately (NOT byte-compared)
    const pubKey = fs.readFileSync(path.join(KEYS_DIR, 'es256-test.pub'), 'utf-8');
    const verify = crypto.createVerify('SHA256');
    verify.update(`${parts[0]}.${parts[1]}`);
    expect(verify.verify(pubKey, Buffer.from(parts[2], 'base64url'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Branded Type Pipeline Verification (Sprint 2 Task 2.4)
// ---------------------------------------------------------------------------

describe('Golden Wire Fixtures — Branded Type Pipeline', () => {
  describe('JWT Claims through parseAccountId', () => {
    const fixture = loadFixture<Record<string, unknown>>('jwt-claims.fixture.json');

    it('tenant_id parses as AccountId and round-trips', () => {
      const tenantId = fixture.tenant_id as string;
      const parsed = parseAccountId(tenantId);
      const serialized = serializeAccountId(parsed);
      expect(serialized).toBe(tenantId);
    });

    it('fixture tenant_id is already in canonical form', () => {
      const tenantId = fixture.tenant_id as string;
      // parseAccountId should not alter a canonical value
      const parsed = parseAccountId(tenantId);
      expect(String(parsed)).toBe(tenantId);
    });
  });

  describe('Billing fixtures through parseMicroUSD', () => {
    const streamFixtures = loadFixture<Record<string, Record<string, unknown>>>('stream-event.fixture.json');

    it('stream_end.cost_micro parses as MicroUSD and round-trips', () => {
      const costMicro = streamFixtures.stream_end.cost_micro as string;
      const parsed = parseMicroUSD(costMicro);
      const serialized = serializeMicroUSD(parsed);
      expect(serialized).toBe(costMicro);
    });

    it('cost_micro value is non-negative', () => {
      const costMicro = streamFixtures.stream_end.cost_micro as string;
      const parsed = parseMicroUSD(costMicro);
      expect(parsed >= 0n).toBe(true);
    });
  });

  describe('Pool IDs through parsePoolId', () => {
    const billingReq = loadFixture<Record<string, unknown>>('billing-request.fixture.json');
    const billingRes = loadFixture<Record<string, unknown>>('billing-response.fixture.json');
    const streamFixtures = loadFixture<Record<string, Record<string, unknown>>>('stream-event.fixture.json');

    it('billing-request pool_id parses as PoolId', () => {
      const poolId = billingReq.pool_id as string;
      const parsed = parsePoolId(poolId);
      expect(parsed).toBe(poolId);
    });

    it('billing-response pool_id parses as PoolId', () => {
      const poolId = billingRes.pool_id as string;
      const parsed = parsePoolId(poolId);
      expect(parsed).toBe(poolId);
    });

    it('stream_start pool_id parses as PoolId', () => {
      const poolId = streamFixtures.stream_start.pool_id as string;
      const parsed = parsePoolId(poolId);
      expect(parsed).toBe(poolId);
    });
  });

  describe('Wire format stability (branded types are compile-time only)', () => {
    it('JWT claims JSON unchanged after AccountId round-trip', () => {
      const fixture = loadFixture<Record<string, unknown>>('jwt-claims.fixture.json');
      const original = canonical(fixture);

      // Round-trip tenant_id through branded type
      const cloned = { ...fixture };
      cloned.tenant_id = serializeAccountId(parseAccountId(fixture.tenant_id as string));

      expect(canonical(cloned)).toBe(original);
    });

    it('billing-request JSON unchanged after PoolId round-trip', () => {
      const fixture = loadFixture<Record<string, unknown>>('billing-request.fixture.json');
      const original = canonical(fixture);

      const cloned = { ...fixture };
      cloned.pool_id = parsePoolId(fixture.pool_id as string);

      expect(canonical(cloned)).toBe(original);
    });

    it('stream_end JSON unchanged after MicroUSD round-trip', () => {
      const streamFixtures = loadFixture<Record<string, Record<string, unknown>>>('stream-event.fixture.json');
      const original = canonical(streamFixtures.stream_end);

      const cloned = { ...streamFixtures.stream_end };
      cloned.cost_micro = serializeMicroUSD(parseMicroUSD(streamFixtures.stream_end.cost_micro as string));

      expect(canonical(cloned)).toBe(original);
    });
  });
});
