#!/usr/bin/env node
// observatory/scripts/refresh-data.mjs — derive the quantitative panel data
// from the CANONICAL experiment artifacts. Runs as predev/prebuild so the
// observatory can never drift into hardcoded-constant theater again
// (KEEPER finding, run observatory-0610b: data.ts carried sample-derived
// constants showing the WRONG H1 state).
//
// Reads (canonical, relative to loa-finn repo root = ../..):
//   tmp/cop-prod-atoms-snapshot.jsonl       — CostAtom envelopes
//   scripts/playtest/out/driver-phase*.jsonl — request-side driver records
//   scripts/playtest/cop-bars.json           — sha-pinned pre-registered bars
//   scripts/playtest/out/readout.json        — cop-readout output (OPTIONAL;
//                                              verdicts render ONLY from this)
// Emits: src/lib/data.generated.json

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const out = join(here, '..', 'src', 'lib', 'data.generated.json');

function p50(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ── atoms ────────────────────────────────────────────────────────────
const atomsPath = join(repo, 'tmp', 'cop-prod-atoms-snapshot.jsonl');
const atoms = { total: 0, a_relay: 0, b_enrich: 0, gates: {}, sums: { inference: 0n, infra: 0n, orchestration: 0n, total: 0n }, malformed: 0 };
if (existsSync(atomsPath)) {
  for (const line of readFileSync(atomsPath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || !t.startsWith('{')) continue;
    try {
      const a = JSON.parse(t).atom;
      atoms.total++;
      if (a.call_class === 'A_relay') atoms.a_relay++; else atoms.b_enrich++;
      const g = a.orchestration.gate_decision;
      atoms.gates[g] = (atoms.gates[g] ?? 0) + 1;
      atoms.sums.inference += BigInt(a.inference.cost_micro);
      atoms.sums.infra += BigInt(a.infra.cost_micro);
      atoms.sums.orchestration += BigInt(a.orchestration.cost_micro);
      atoms.sums.total += BigInt(a.total_micro);
    } catch { atoms.malformed++; }
  }
}

// ── driver phases ────────────────────────────────────────────────────
const outDir = join(repo, 'scripts', 'playtest', 'out');
const phaseMap = new Map(); // key `${phase}:${level??''}`
if (existsSync(outDir)) {
  for (const f of readdirSync(outDir).filter((f) => f.startsWith('driver-') && f.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(outDir, f), 'utf-8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let r; try { r = JSON.parse(t); } catch { continue; }
      if (r.seq === undefined) continue; // abort markers etc.
      const key = `${r.phase}:${r.level ?? ''}`;
      if (!phaseMap.has(key)) phaseMap.set(key, { phase: r.phase, level: r.level, rows: [] });
      phaseMap.get(key).rows.push(r);
    }
  }
}
const phases = [...phaseMap.values()]
  .sort((a, b) => a.phase - b.phase || (a.level ?? 0) - (b.level ?? 0))
  .map(({ phase, level, rows }) => {
    const a = rows.filter((r) => r.call_class === 'A_relay');
    const b = rows.filter((r) => r.call_class === 'B_enrich');
    const routed = b.filter((r) => (r.gate_decision ?? '').startsWith('ROUTE_CHEVAL')).length;
    return {
      phase, ...(level !== undefined && level !== null ? { level } : {}),
      total_calls: rows.length, a_relay: a.length, b_enrich: b.length,
      gate_routed: routed, gate_closed: b.length - routed,
      a_relay_p50_ms: p50(a.map((r) => r.latency_ms)),
      b_p50_ms: p50(b.map((r) => r.latency_ms)),
      b_gate_status: b.length === 0 ? 'N/A' : routed > 0 ? 'ROUTED' : 'FAIL_CLOSED',
    };
  });

// ── bars (sha-pinned) ────────────────────────────────────────────────
const barsRaw = readFileSync(join(repo, 'scripts', 'playtest', 'cop-bars.json'), 'utf-8');
const bars = JSON.parse(barsRaw);
const barsSha = createHash('sha256').update(barsRaw).digest('hex');

// ── readout (the ONLY verdict source) ────────────────────────────────
const readoutPath = join(outDir, 'readout.json');
const readout = existsSync(readoutPath) ? JSON.parse(readFileSync(readoutPath, 'utf-8')) : null;

const generated = {
  generated_at: new Date().toISOString(),
  atoms: {
    total: atoms.total, a_relay: atoms.a_relay, b_enrich: atoms.b_enrich,
    gates: atoms.gates, malformed: atoms.malformed,
    sum_inference_micro: Number(atoms.sums.inference),
    sum_infra_micro: Number(atoms.sums.infra),
    sum_orchestration_micro: Number(atoms.sums.orchestration),
    sum_total_micro: Number(atoms.sums.total),
  },
  phases,
  bars: { ...bars, sha256: barsSha },
  readout, // null until cop-readout writes it — panels show AWAITING READOUT
};

writeFileSync(out, JSON.stringify(generated, null, 2));
console.log(`[refresh-data] ${atoms.total} atoms · ${phases.length} phase rows · bars sha ${barsSha.slice(0, 12)} · readout: ${readout ? 'PRESENT' : 'awaiting'}`);
