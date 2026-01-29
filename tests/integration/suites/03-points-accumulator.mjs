/**
 * Integration Test Suite
 * Auto-migrated from test-business-logic.mjs
 */
import { promises as fs } from "node:fs";
import { join, basename } from "node:path";
import { section, assert, log, skip, sleep, createTestFile, hashContent, randomUUID, resources } from "../helpers.mjs";
import { PointsAccumulator, createAccumulator } from "../../../build/qdrant/accumulator.js";

export async function testPointsAccumulator(qdrant) {
  section("3. PointsAccumulator (Batch Pipeline)");

  const makeVector = (seed) => Array.from({ length: 768 }, (_, i) => Math.sin(seed * i) * 0.5 + 0.5);
  const testCollection = `acc_test_${Date.now()}`;

  try {
    await qdrant.deleteCollection(testCollection);
  } catch (e) {}
  await qdrant.createCollection(testCollection, 768, "Cosine");

  // === TEST: Basic accumulation and flush ===
  log("info", "Testing basic accumulation...");

  const accumulator = new PointsAccumulator(qdrant, testCollection, false, {
    bufferSize: 10,
    flushIntervalMs: 0, // Disable timer for deterministic testing
    ordering: "weak",
  });

  // Add points without exceeding buffer
  const points5 = Array.from({ length: 5 }, (_, i) => ({
    id: randomUUID(),
    vector: makeVector(i),
    payload: { batch: 1, index: i },
  }));
  await accumulator.add(points5);

  let stats = accumulator.getStats();
  assert(stats.pendingPoints === 5, `Points pending in buffer: ${stats.pendingPoints}`);
  assert(stats.flushCount === 0, `No flush yet: ${stats.flushCount}`);

  // === TEST: Auto-flush by size threshold ===
  log("info", "Testing auto-flush by size...");

  const points15 = Array.from({ length: 15 }, (_, i) => ({
    id: randomUUID(),
    vector: makeVector(i + 100),
    payload: { batch: 2, index: i },
  }));
  await accumulator.add(points15);

  stats = accumulator.getStats();
  // Should have auto-flushed twice (10+10), leaving 0 in buffer
  assert(stats.flushCount >= 1, `Auto-flush triggered: ${stats.flushCount} flushes`);
  assert(stats.totalPointsFlushed >= 10, `Points flushed: ${stats.totalPointsFlushed}`);

  // === TEST: Explicit flush ===
  log("info", "Testing explicit flush...");

  await accumulator.flush();
  stats = accumulator.getStats();
  assert(stats.pendingPoints === 0, `Buffer empty after flush: ${stats.pendingPoints}`);
  assert(stats.totalPointsFlushed === 20, `All points flushed: ${stats.totalPointsFlushed}`);

  // Verify points in Qdrant
  const info = await qdrant.getCollectionInfo(testCollection);
  assert(info.pointsCount === 20, `Points in Qdrant: ${info.pointsCount}`);

  // === TEST: Factory function with env vars ===
  log("info", "Testing createAccumulator factory...");

  const factoryAcc = createAccumulator(qdrant, testCollection, false);
  assert(factoryAcc instanceof PointsAccumulator, "Factory returns PointsAccumulator");

  // === TEST: Timer-based auto-flush ===
  log("info", "Testing timer-based flush...");

  const timerCollection = `acc_timer_${Date.now()}`;
  await qdrant.createCollection(timerCollection, 768, "Cosine");

  const timerAccumulator = new PointsAccumulator(qdrant, timerCollection, false, {
    bufferSize: 100, // High threshold so only timer triggers
    flushIntervalMs: 200, // 200ms timer
    ordering: "weak",
  });

  const timerPoints = Array.from({ length: 5 }, (_, i) => ({
    id: randomUUID(),
    vector: makeVector(i + 200),
    payload: { timer: true },
  }));
  await timerAccumulator.add(timerPoints);

  // Wait for timer
  await sleep(300);

  // Flush should have been triggered by timer
  await timerAccumulator.flush(); // Ensure all done
  const timerStats = timerAccumulator.getStats();
  assert(timerStats.flushCount >= 1, `Timer triggered flush: ${timerStats.flushCount}`);

  // Verify
  const timerInfo = await qdrant.getCollectionInfo(timerCollection);
  assert(timerInfo.pointsCount === 5, `Timer points in Qdrant: ${timerInfo.pointsCount}`);

  // === TEST: Reset stats ===
  log("info", "Testing stats reset...");

  timerAccumulator.resetStats();
  const resetStats = timerAccumulator.getStats();
  assert(resetStats.totalPointsFlushed === 0, "Stats reset: totalPointsFlushed");
  assert(resetStats.flushCount === 0, "Stats reset: flushCount");

  // Cleanup
  await qdrant.deleteCollection(testCollection);
  await qdrant.deleteCollection(timerCollection);
  log("pass", "Cleanup complete");
}
