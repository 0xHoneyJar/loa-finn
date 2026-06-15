// src/research/forecast-registry.test.ts — sprint:corpus-a T0b negative tests.
// Proves the DD-3 guard (no settle without a registered forecast) and DD-3′
// (forecasts are per-horizon; a survival horizon never resolves the discovery p).

import { describe, it, expect } from "vitest"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ulid } from "ulid"
import {
  registerForecast,
  requireForecast,
  readForecasts,
  findForecast,
  NoForecastError,
} from "./forecast-registry.js"
import { questionHash } from "./cost-atom-research.js"

const tmpPath = (): string => join(tmpdir(), `forecast-registry-${ulid()}.jsonl`)
const Q = "Is the $KINS on-chain economy real sustained demand?"

describe("forecast-registry (T0b)", () => {
  it("registers per-horizon forecasts and finds each by its own horizon", async () => {
    const path = tmpPath()
    await registerForecast({ question: Q, horizon: "discovery", probability_ppm: 300_000, resolution_criterion: "bars v1" }, { path })
    await registerForecast({ question: Q, horizon: "survival_30d", probability_ppm: 450_000, resolution_criterion: "bars v1" }, { path })

    const all = await readForecasts(path)
    expect(all.length).toBe(2)
    const qh = questionHash(Q)
    expect(findForecast(all, qh, "discovery")?.probability_ppm).toBe(300_000)
    expect(findForecast(all, qh, "survival_30d")?.probability_ppm).toBe(450_000)
  })

  it("requireForecast returns the registered forecast for its horizon", async () => {
    const path = tmpPath()
    await registerForecast({ question: Q, horizon: "discovery", probability_ppm: 300_000, resolution_criterion: "bars v1" }, { path })
    const f = await requireForecast(Q, "discovery", path)
    expect(f.horizon).toBe("discovery")
    expect(f.outcome).toBeNull() // unresolved until a deterministic settle
  })

  it("DD-3: requireForecast throws when no forecast was registered", async () => {
    const path = tmpPath()
    await expect(requireForecast(Q, "discovery", path)).rejects.toBeInstanceOf(NoForecastError)
  })

  it("DD-3′: a survival horizon does NOT resolve the discovery forecast (per-horizon)", async () => {
    const path = tmpPath()
    // only the discovery forecast is registered
    await registerForecast({ question: Q, horizon: "discovery", probability_ppm: 300_000, resolution_criterion: "bars v1" }, { path })
    // a t+30 settle must NOT silently borrow the discovery p
    await expect(requireForecast(Q, "survival_30d", path)).rejects.toBeInstanceOf(NoForecastError)
  })

  it("rejects an out-of-range probability_ppm", async () => {
    const path = tmpPath()
    await expect(
      registerForecast({ question: Q, horizon: "discovery", probability_ppm: 1_500_000, resolution_criterion: "x" }, { path }),
    ).rejects.toThrow(/probability_ppm/)
  })
})
