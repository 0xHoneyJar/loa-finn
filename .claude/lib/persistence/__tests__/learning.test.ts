import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LearningStore, type Learning } from "../learning/learning-store.js";
import {
  scoreAllGates,
  passesQualityGates,
  DefaultQualityGateScorer,
  GATE_THRESHOLDS,
  MINIMUM_TOTAL_SCORE,
} from "../learning/quality-gates.js";

// ── Temp Directory ─────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "learning-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helper ─────────────────────────────────────────────────

function makeHighQualityLearning(): Omit<Learning, "id" | "created" | "gates" | "status"> {
  return {
    source: "sprint",
    trigger:
      "When deploying after a major update and the build fails with timeout errors during CI/CD pipeline execution",
    pattern:
      "A common pattern is that CI builds fail after updating dependencies because the new packages download takes longer. This approach involves setting a general timeout override in the pipeline config to handle similar transient network delays.",
    solution:
      "We tested and verified this works: Add `timeout: 30m` to the build step in CI config. This was confirmed to fix the issue. Passed all checks and validated in multiple environments.",
    target: "devcontainer",
  };
}

describe("LearningStore CRUD", () => {
  it("adds and retrieves a learning", async () => {
    const store = new LearningStore({ basePath: tmpDir });

    const input = makeHighQualityLearning();
    const learning = await store.addLearning(input);

    expect(learning.id).toBeTruthy();
    expect(learning.created).toBeTruthy();
    expect(learning.status).toBe("active"); // Non-loa target auto-activates

    // Retrieve
    const found = await store.getLearning(learning.id);
    expect(found).not.toBeNull();
    expect(found!.trigger).toBe(input.trigger);
  });

  it("sends loa-target learnings to pending-self", async () => {
    const store = new LearningStore({ basePath: tmpDir });

    const learning = await store.addLearning({
      ...makeHighQualityLearning(),
      target: "loa",
    });

    // Should be in pending (not active store)
    expect(learning.status).toBe("pending");

    const pending = await store.getPendingLearnings();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(learning.id);

    // Active store should be empty
    const active = await store.getLearnings("active");
    expect(active).toHaveLength(0);
  });

  it("records effectiveness tracking", async () => {
    const store = new LearningStore({ basePath: tmpDir });

    const learning = await store.addLearning(makeHighQualityLearning());
    await store.recordApplication(learning.id, true);
    await store.recordApplication(learning.id, true);
    await store.recordApplication(learning.id, false);

    const updated = await store.getLearning(learning.id);
    expect(updated!.effectiveness).toEqual(
      expect.objectContaining({
        applications: 3,
        successes: 2,
        failures: 1,
      }),
    );
  });

  it("finds matching learnings by keyword", async () => {
    const store = new LearningStore({ basePath: tmpDir });

    await store.addLearning(makeHighQualityLearning());
    await store.addLearning({
      ...makeHighQualityLearning(),
      trigger: "When database migrations fail during deployment with schema errors",
      pattern:
        "Database migration failures often occur when schema changes conflict. A general approach is to add verification steps.",
    });

    const matches = await store.findMatchingLearnings("deploying build fails timeout");
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Quality Gates Scoring", () => {
  it("scores a high-quality learning above thresholds", () => {
    const learning = {
      ...makeHighQualityLearning(),
      gates: undefined as any,
    };
    const gates = scoreAllGates(learning);

    expect(gates.discovery_depth).toBeGreaterThanOrEqual(GATE_THRESHOLDS.discovery_depth);
    expect(gates.trigger_clarity).toBeGreaterThanOrEqual(GATE_THRESHOLDS.trigger_clarity);
    expect(gates.verification).toBeGreaterThanOrEqual(GATE_THRESHOLDS.verification);

    const total =
      gates.discovery_depth + gates.reusability + gates.trigger_clarity + gates.verification;
    expect(total).toBeGreaterThanOrEqual(MINIMUM_TOTAL_SCORE);
    expect(passesQualityGates({ ...learning, gates })).toBe(true);
  });

  it("rejects a low-quality learning", () => {
    const learning = {
      source: "retrospective" as const,
      trigger: "",
      pattern: "x",
      solution: "y",
      target: "openclaw" as const,
    };

    const gates = scoreAllGates(learning);
    expect(gates.trigger_clarity).toBe(0); // Empty trigger
    expect(passesQualityGates({ ...learning, gates })).toBe(false);
  });

  it("DefaultQualityGateScorer implements IQualityGateScorer", () => {
    const scorer = new DefaultQualityGateScorer();
    const learning = makeHighQualityLearning();

    const gates = scorer.scoreAll(learning);
    expect(gates.discovery_depth).toBeGreaterThan(0);
    expect(scorer.passes({ ...learning, gates })).toBe(true);
  });

  it("WAL-less degradation works", async () => {
    // Store without WAL should still function
    const store = new LearningStore({ basePath: tmpDir });

    const learning = await store.addLearning(makeHighQualityLearning());
    expect(learning.id).toBeTruthy();

    // Verify file was written directly
    const storeFile = path.join(tmpDir, "learnings.json");
    expect(fs.existsSync(storeFile)).toBe(true);
  });
});

describe("LearningStore Concurrency", () => {
  it("10 concurrent addLearning calls result in all 10 learnings present", async () => {
    const store = new LearningStore({ basePath: tmpDir });

    // Fire 10 concurrent addLearning calls
    const promises = Array.from({ length: 10 }, (_, i) =>
      store.addLearning({
        ...makeHighQualityLearning(),
        trigger: `Concurrent trigger ${i}`,
      }),
    );

    const results = await Promise.all(promises);

    // All 10 should have unique IDs
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(10);

    // All 10 should be in the store
    const allLearnings = await store.getLearnings();
    expect(allLearnings).toHaveLength(10);

    // Verify each trigger is unique and present
    const triggers = allLearnings.map((l) => l.trigger);
    for (let i = 0; i < 10; i++) {
      expect(triggers).toContain(`Concurrent trigger ${i}`);
    }
  });

  it("concurrent recordApplication calls do not lose updates", async () => {
    const store = new LearningStore({ basePath: tmpDir });

    const learning = await store.addLearning(makeHighQualityLearning());

    // Fire 5 concurrent recordApplication calls
    const promises = Array.from({ length: 5 }, () =>
      store.recordApplication(learning.id, true),
    );

    await Promise.all(promises);

    const updated = await store.getLearning(learning.id);
    expect(updated!.effectiveness!.applications).toBe(5);
    expect(updated!.effectiveness!.successes).toBe(5);
  });
});
