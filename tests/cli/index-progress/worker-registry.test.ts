/**
 * The on-disk record of live index workers (bd tea-rags-mcp-f924y).
 *
 * A worker registers itself, so a later sweep can tell a tea-rags index worker
 * from any other process that happens to hold the same pid, and knows whether
 * the worker was handed off (allowed to run without its supervisor) and when it
 * last made progress.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  IndexWorkerRegistry,
  indexWorkerRegistryDir,
  type IndexWorkerRecord,
} from "../../../src/cli/index-progress/worker-registry.js";

function record(overrides: Partial<IndexWorkerRecord> = {}): IndexWorkerRecord {
  return {
    pid: 4242,
    supervisorPid: 4241,
    startedAtMs: 1_000,
    entryScript: "/checkout/build/cli/index.js",
    projectPath: "/repo",
    lastProgressAtMs: 1_000,
    ...overrides,
  };
}

describe("IndexWorkerRegistry (f924y)", () => {
  let dir: string;
  let registry: IndexWorkerRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "index-worker-registry-"));
    registry = new IndexWorkerRegistry(join(dir, "workers"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists what was registered, one record per worker", () => {
    registry.register(record({ pid: 1 }));
    registry.register(record({ pid: 2, projectPath: "/other" }));

    expect(registry.list().sort((a, b) => a.pid - b.pid)).toEqual([
      record({ pid: 1 }),
      record({ pid: 2, projectPath: "/other" }),
    ]);
  });

  it("records the hand-off and the latest progress on the worker's own record", () => {
    registry.register(record());

    registry.markHandedOff(4242, 5_000);
    registry.recordProgress(4242, 7_000);

    expect(registry.list()).toEqual([record({ handedOffAtMs: 5_000, lastProgressAtMs: 7_000 })]);
  });

  it("forgets a worker once it unregisters", () => {
    registry.register(record());

    registry.unregister(4242);

    expect(registry.list()).toEqual([]);
  });

  it("does not resurrect a record an update finds already gone", () => {
    registry.recordProgress(4242, 7_000);

    expect(registry.list()).toEqual([]);
  });

  it("skips a record that does not parse instead of failing the whole listing", () => {
    registry.register(record());
    writeFileSync(join(dir, "workers", "index-worker-9.json"), "{ half-written");

    expect(registry.list()).toEqual([record()]);
  });

  it("lists nothing before any worker registered", () => {
    expect(registry.list()).toEqual([]);
  });

  it("lives under the data directory the CLI resolves", () => {
    expect(indexWorkerRegistryDir("/data")).toBe(join("/data", "workers"));
  });
});
