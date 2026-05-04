// Cycle-2 Substrate-Runtime · Sprint-5 SPIKE
// Validates the load-bearing primitive for the entire 7-sprint plan:
//   Can a worker_thread dynamic-import an absolute .mjs file path,
//   call its default export, and read its named exports?
//
// If GREEN: Sprint 1-7 architecture stands (worker_threads + dynamic-import
//   + capability-bounded Effect Layer is the trust:internal isolation tier).
// If RED:   architecture pivots to isolated-vm or subprocess+permissions
//   BEFORE authoring 7 sprints on the wrong primitive.
//
// Run: node scripts/substrate-spike.mjs

import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (isMainThread) {
  const dir = mkdtempSync(join(tmpdir(), "substrate-spike-"));
  const modPath = join(dir, "spike-fixture.mjs");

  writeFileSync(
    modPath,
    [
      "// Synthetic substrate-construct fixture (no Effect dep · pure JS)",
      "export default function add(a, b) { return a + b; }",
      "export const meta = { name: 'spike-fixture', version: '1.0.0', ts: Date.now() };",
      "export async function asyncEcho(value) { return { echoed: value, atIso: new Date().toISOString() }; }",
      "",
    ].join("\n"),
  );

  console.log(`[parent] fixture written to ${modPath}`);
  console.log(`[parent] spawning worker (file://${fileURLToPath(import.meta.url)})...`);

  const start = performance.now();
  const worker = new Worker(fileURLToPath(import.meta.url), {
    workerData: { modPath },
  });

  let resolved = false;

  const cleanup = () => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  };

  worker.on("message", async (msg) => {
    if (resolved) return;
    resolved = true;
    const elapsedMs = (performance.now() - start).toFixed(2);
    console.log(`[parent] worker responded in ${elapsedMs}ms:`);
    console.log(JSON.stringify(msg, null, 2));

    await worker.terminate();
    cleanup();

    const expected =
      msg.ok === true &&
      msg.addResult === 5 &&
      msg.echoResult?.echoed === "hello" &&
      msg.meta?.name === "spike-fixture" &&
      typeof msg.meta?.ts === "number";

    if (expected) {
      console.log("\nSPIKE GREEN ✅  worker_threads + dynamic-import works for substrate constructs.");
      console.log("  - default export callable: yes");
      console.log("  - named export readable: yes");
      console.log("  - async export awaitable: yes");
      console.log("  - absolute file:// URL import: yes");
      console.log(`  - cold-start overhead: ${elapsedMs}ms`);
      console.log("  → Sprint 1-7 architecture stands. Proceed.");
      process.exit(0);
    } else {
      console.log("\nSPIKE RED ❌  worker_threads dynamic-import returned unexpected shape.");
      console.log("  → Architecture pivot required before Sprint 1.");
      process.exit(1);
    }
  });

  worker.on("error", async (err) => {
    if (resolved) return;
    resolved = true;
    console.error("[parent] worker error:", err);
    cleanup();
    console.log("\nSPIKE RED ❌  worker errored during dynamic-import.");
    console.log("  → Likely worker_threads cannot resolve the absolute file:// URL.");
    console.log("  → Architecture pivot required before Sprint 1.");
    process.exit(2);
  });

  worker.on("exit", (code) => {
    if (resolved) return;
    resolved = true;
    cleanup();
    console.log(`\nSPIKE INDETERMINATE  worker exited (code=${code}) without posting a message.`);
    process.exit(3);
  });
} else {
  // Worker side
  try {
    const { modPath } = workerData;
    const url = pathToFileURL(modPath).href;

    // The load-bearing op: dynamic-import an absolute .mjs from inside a worker_thread.
    const mod = await import(url);

    const addResult = mod.default(2, 3);
    const echoResult = await mod.asyncEcho("hello");

    parentPort.postMessage({
      ok: true,
      url,
      addResult,
      echoResult,
      meta: mod.meta,
      hasDefault: typeof mod.default === "function",
      hasNamed: typeof mod.meta === "object",
      hasAsync: typeof mod.asyncEcho === "function",
    });
  } catch (err) {
    parentPort.postMessage({
      ok: false,
      error: String(err),
      stack: err?.stack ?? null,
      code: err?.code ?? null,
    });
  }
}
