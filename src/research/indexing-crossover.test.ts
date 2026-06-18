// src/research/indexing-crossover.test.ts — the crossover reader's invariants
// (epic bd-idx-tco-exp-s7r5, synthesis task .4).
//
// The headline test is the KEN-THOMPSON INVARIANT: a verdict can never claim a
// trust higher than the WEAKEST row it rests on. This is the mechanical refusal
// that prevents a projection from being presented as a measurement.

import { describe, expect, it } from "vitest"
import {
  DEFAULT_CROSSOVER_PARAMS,
  monthlyToilHours,
  synthesizeCrossover,
  tcoBreakdown,
  weakestCostSource,
} from "./indexing-crossover.js"
import type { IndexingExperimentRow } from "./schemas/indexing-experiment-row.js"
import { usdToMicro } from "./schemas/indexing-experiment-row.js"

function row(overrides: Partial<IndexingExperimentRow> = {}): IndexingExperimentRow {
  return {
    row_id: "r",
    run_id: "run-1",
    date: "2026-06-16",
    scenario: "1x",
    layer: "L1-curated",
    config: "ponder-railway",
    chain: 80094,
    collection_count: 93,
    event_count: 3_540_000,
    cost_usd_month_micro: usdToMicro(58),
    cost_source: "measured",
    toil_minutes_setup: 480,
    toil_incidents_30d: 3,
    toil_minutes_per_incident: 60,
    latency_p50_ms: 120,
    freshness_lag_s: 12,
    sovereignty: 1,
    scale_ceiling: "",
    cost_basis: "",
    retrieved_ts: null,
    notes: "",
    ...overrides,
  }
}

// --- Ken-Thompson invariant -------------------------------------------------
describe("weakestCostSource (trust algebra)", () => {
  it("measured + measured ⇒ measured", () => {
    expect(weakestCostSource(["measured", "measured"])).toBe("measured")
  })
  it("measured + vendor-quote ⇒ vendor-quote", () => {
    expect(weakestCostSource(["measured", "vendor-quote"])).toBe("vendor-quote")
  })
  it("vendor-quote + projected ⇒ projected", () => {
    expect(weakestCostSource(["vendor-quote", "projected"])).toBe("projected")
  })
  it("empty ⇒ projected (assume the floor)", () => {
    expect(weakestCostSource([])).toBe("projected")
  })
})

describe("verdict trust is inherited, never inflated", () => {
  it("a measured-Ponder vs vendor-quote-Envio crossover is at best vendor-quote", () => {
    const rows = [
      row({ config: "ponder-railway", cost_source: "measured", cost_usd_month_micro: usdToMicro(58) }),
      row({ config: "envio-hyperindex", cost_source: "vendor-quote", sovereignty: 0, toil_incidents_30d: 0, toil_minutes_per_incident: 0, toil_minutes_setup: 60, cost_usd_month_micro: usdToMicro(70) }),
    ]
    const v = synthesizeCrossover(rows)
    expect(v.overall_trust).toBe("vendor-quote")
    expect(v.ratification).toMatch(/DO NOT RATIFY/)
  })

  it("never RATIFY unless every input is measured", () => {
    const allMeasured = [
      row({ config: "ponder-railway", cost_source: "measured" }),
      row({ config: "envio-hyperindex", cost_source: "measured", sovereignty: 0, toil_incidents_30d: 0, toil_minutes_per_incident: 0, cost_usd_month_micro: usdToMicro(70) }),
    ]
    const v = synthesizeCrossover(allMeasured)
    expect(v.overall_trust).toBe("measured")
    expect(v.ratification).toMatch(/RATIFY: every input is measured/)
  })

  it("any projected footprint drags overall trust to projected", () => {
    const rows = [
      row({ scenario: "1x", config: "ponder-railway", cost_source: "measured" }),
      row({ scenario: "1x", config: "envio-hyperindex", cost_source: "vendor-quote", sovereignty: 0, cost_usd_month_micro: usdToMicro(70) }),
      row({ scenario: "5x", config: "ponder-railway", cost_source: "projected", cost_usd_month_micro: usdToMicro(290) }),
      row({ scenario: "5x", config: "envio-hyperindex", cost_source: "projected", sovereignty: 0, cost_usd_month_micro: usdToMicro(120) }),
    ]
    const v = synthesizeCrossover(rows)
    expect(v.overall_trust).toBe("projected")
  })
})

// --- TCO-incl-toil ----------------------------------------------------------
describe("TCO folds toil in at the stated rate", () => {
  it("monthlyToilHours amortizes setup + monthly incidents", () => {
    // 480 setup / 12mo = 40 min/mo; 3 incidents * 60 min = 180 min/mo; total 220 min = 3.667h
    const h = monthlyToilHours(row(), 12)
    expect(h).toBeCloseTo(220 / 60, 5)
  })

  it("toil can FLIP the winner: cheaper-but-toily loses to pricier-but-managed", () => {
    const rows = [
      // sovereign: cheaper $/mo but heavy toil
      row({ config: "ponder-railway", cost_source: "vendor-quote", cost_usd_month_micro: usdToMicro(58), toil_minutes_setup: 480, toil_incidents_30d: 6, toil_minutes_per_incident: 90 }),
      // managed: pricier $/mo but zero toil
      row({ config: "envio-hyperindex", cost_source: "vendor-quote", sovereignty: 0, cost_usd_month_micro: usdToMicro(70), toil_minutes_setup: 30, toil_incidents_30d: 0, toil_minutes_per_incident: 0 }),
    ]
    const v = synthesizeCrossover(rows, { operator_rate_usd_hr: 150, amortize_months: 12 })
    const fp = v.l1!.footprints[0]
    expect(fp.pure_cost_winner.config).toBe("ponder-railway") // cheaper $/mo
    expect(fp.tco_incl_toil_winner.config).toBe("envio-hyperindex") // wins once toil is priced
    expect(fp.toil_flips_winner).toBe(true)
  })

  it("breakdown reports pure + toil + combined", () => {
    const b = tcoBreakdown(row({ cost_usd_month_micro: usdToMicro(58) }), DEFAULT_CROSSOVER_PARAMS)
    expect(b.pure_usd_month).toBe(58)
    expect(b.toil_usd_month).toBeGreaterThan(0)
    expect(b.tco_incl_toil_usd).toBeCloseTo(b.pure_usd_month + b.toil_usd_month, 2)
  })
})

describe("breakeven toil rate removes the rate assumption", () => {
  it("ties Ponder ($58, 3.67h toil) and Envio ($70, ~0.33h) at ~$3.60/hr", () => {
    const rows = [
      row({ config: "ponder-railway", cost_source: "measured", cost_usd_month_micro: usdToMicro(58), toil_minutes_setup: 480, toil_incidents_30d: 3, toil_minutes_per_incident: 60 }),
      row({ config: "envio-hyperindex", cost_source: "vendor-quote", sovereignty: 0, cost_usd_month_micro: usdToMicro(70), toil_minutes_setup: 240, toil_incidents_30d: 0, toil_minutes_per_incident: 0 }),
    ]
    const v = synthesizeCrossover(rows)
    // ponder toil = (480/12 + 180)/60 = 3.6667h; envio = (240/12)/60 = 0.3333h
    // breakeven = (70-58)/(3.6667-0.3333) = 12/3.3333 = 3.60
    expect(v.l1!.footprints[0].breakeven_toil_rate_usd_hr).toBeCloseTo(3.6, 1)
  })

  it("is null when the cheapest-$ option is ALSO the least toily (dominates everywhere)", () => {
    const rows = [
      row({ config: "ponder-railway", cost_usd_month_micro: usdToMicro(50), toil_incidents_30d: 0, toil_minutes_per_incident: 0, toil_minutes_setup: 0 }),
      row({ config: "envio-hyperindex", sovereignty: 0, cost_usd_month_micro: usdToMicro(70), toil_incidents_30d: 5, toil_minutes_per_incident: 60, toil_minutes_setup: 240 }),
    ]
    const v = synthesizeCrossover(rows)
    expect(v.l1!.footprints[0].breakeven_toil_rate_usd_hr).toBeNull()
  })
})

// --- L1 reference rows + L2 curve -------------------------------------------
describe("single-config scenarios are reference, not head-to-head", () => {
  it("an as-billed Ponder row is surfaced as reference, excluded from the winner calc", () => {
    const rows = [
      row({ scenario: "as-billed", config: "ponder-railway", cost_usd_month_micro: usdToMicro(133.21) }),
      row({ scenario: "1x", config: "ponder-railway", cost_usd_month_micro: usdToMicro(58) }),
      row({ scenario: "1x", config: "envio-hyperindex", cost_source: "vendor-quote", sovereignty: 0, cost_usd_month_micro: usdToMicro(70) }),
    ]
    const v = synthesizeCrossover(rows)
    expect(v.l1!.reference_rows.some((r) => r.scenario === "as-billed")).toBe(true)
    expect(v.l1!.footprints.every((f) => f.scenario !== "as-billed")).toBe(true)
  })
})

describe("L2 firehose curve + storage delta", () => {
  function l2(store: "clickhouse" | "postgres", count: number, usd: number): IndexingExperimentRow {
    return row({
      layer: "L2-firehose",
      config: store === "clickhouse" ? "hypersync->clickhouse" : "hypersync->postgres",
      scenario: `scale-${count}`,
      collection_count: count,
      cost_source: "projected",
      cost_usd_month_micro: usdToMicro(usd),
      scale_ceiling: "registration bends at unbounded collections",
    })
  }
  it("computes the ClickHouse-vs-Postgres delta at max scale", () => {
    const rows = [
      l2("clickhouse", 100_000, 40),
      l2("postgres", 100_000, 95),
      l2("clickhouse", 100, 8),
      l2("postgres", 100, 10),
    ]
    const v = synthesizeCrossover(rows)
    expect(v.l2).not.toBeNull()
    expect(v.l2!.storage_delta_usd_at_max).toBe(55) // 95 - 40
    expect(v.l2!.storage_delta_note).toMatch(/ClickHouse cheaper/)
    expect(v.l2!.trust).toBe("projected")
  })
})
